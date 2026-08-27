import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AccountKind, Campaign, CampaignStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuditService } from '../admin/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { PaystackService } from './paystack.service';

/**
 * Self-service campaign funding via Paystack.
 *
 * NOTE ON SCOPE: the SOW funds campaigns by admin-recorded bank transfer; this
 * client-paid card path was added on explicit instruction. It replaces the
 * admin approve → record-transfer steps for campaigns funded this way: a quoted
 * campaign that is paid for goes LIVE directly.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly paystack: PaystackService,
    private readonly notifications: NotificationService,
  ) {}

  private readonly logger = new Logger(PaymentsService.name);

  /** Client-initiated: verify the reference and fund the caller's own campaign. */
  async verifyAndFund(userId: string, campaignId: string, reference: string): Promise<{ status: string; message: string }> {
    const org = await this.prisma.clientOrg.findFirst({ where: { ownerUserId: userId } });
    if (!org) throw new ForbiddenException('This account has no client organisation.');

    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.clientOrgId !== org.id) throw new NotFoundException('No such campaign.');

    return this.settleCharge(campaign, reference, userId);
  }

  /**
   * Paystack webhook backstop: a charge.success signed by Paystack funds the campaign
   * even if the client never fired the verify callback (browser closed after paying).
   * Authenticity is the HMAC signature; we still re-verify the reference and match the
   * amount before moving money. Shares settleCharge, so it's idempotent with the client
   * path via the reference key.
   */
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<{ handled: boolean }> {
    if (!this.paystack.verifySignature(rawBody, signature)) {
      throw new UnauthorizedException('Invalid webhook signature.');
    }
    const event = JSON.parse(rawBody.toString('utf8')) as {
      event?: string;
      data?: { reference?: string; metadata?: { campaign_id?: string } };
    };
    if (event.event !== 'charge.success') return { handled: false };

    const reference = event.data?.reference;
    const campaignId = event.data?.metadata?.campaign_id;
    if (!reference || !campaignId) {
      this.logger.warn('charge.success without a reference/campaign_id — ignoring.');
      return { handled: false };
    }

    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      this.logger.warn(`Webhook for unknown campaign ${campaignId} — ignoring.`);
      return { handled: false };
    }
    // Attribute the funding to the campaign owner; the webhook has no session user.
    const org = await this.prisma.clientOrg.findUnique({ where: { id: campaign.clientOrgId }, select: { ownerUserId: true } });
    try {
      await this.settleCharge(campaign, reference, org?.ownerUserId ?? campaign.clientOrgId);
    } catch (err) {
      // Already-funded / not-fundable are expected when the client verify won the race.
      if (err instanceof ConflictException) return { handled: true };
      throw err;
    }
    return { handled: true };
  }

  /**
   * The shared settle core: idempotent on the reference, re-verifies the charge with
   * Paystack, matches the amount, credits escrow and takes the campaign LIVE, and opens
   * a reconciliation row. Used by both the client verify and the webhook.
   */
  private async settleCharge(campaign: Campaign, reference: string, actorId: string): Promise<{ status: string; message: string }> {
    if (campaign.priceMinor === null) throw new BadRequestException('Get a quote before paying.');

    // Idempotency keyed on the Paystack reference itself: verifying the same
    // reference twice must never double-credit, whatever the request header says.
    const idempotencyKey = `paystack:${reference}`;
    if (await this.ledger.alreadyPosted(idempotencyKey)) {
      return { status: campaign.status, message: 'Payment already recorded.' };
    }

    // Admin approval is mandatory before any money moves: a campaign is fundable
    // ONLY once an admin has approved it (PENDING_APPROVAL → CONFIRMING_PAYMENT).
    // Paying straight from QUOTED is no longer allowed — nothing goes live without
    // a human review (e.g. against prohibited/contraband content).
    const fundable: CampaignStatus[] = [CampaignStatus.CONFIRMING_PAYMENT];
    if (!fundable.includes(campaign.status)) {
      const hint =
        campaign.status === CampaignStatus.QUOTED || campaign.status === CampaignStatus.PENDING_APPROVAL
          ? ' It must be approved by an admin before payment.'
          : '';
      throw new ConflictException(`A ${campaign.status} campaign cannot be funded.${hint}`);
    }

    // Confirm the charge with Paystack before any money moves.
    const v = await this.paystack.verify(reference);
    if (v.status !== 'success') throw new BadRequestException('That payment did not complete.');
    if (v.currency !== 'NGN') throw new BadRequestException(`Unexpected currency ${v.currency}.`);
    if (BigInt(v.amountMinor) !== campaign.priceMinor) {
      throw new BadRequestException('The amount paid does not match the campaign price.');
    }

    const campaignId = campaign.id;
    const userId = actorId;
    const escrowAccountId =
      campaign.escrowAccountId ?? (await this.ledger.getOrCreateAccount(AccountKind.CAMPAIGN_ESCROW, campaignId));

    const { transactionId, replayed } = await this.ledger.fundCampaign({
      campaignId,
      escrowAccountId,
      amountMinor: campaign.priceMinor,
      idempotencyKey,
      actorId: userId,
    });

    // Only the first funding of this reference takes the campaign live and opens
    // the reconciliation row — a concurrent replay must not re-audit or collide
    // on the unique reference.
    if (!replayed) {
      await this.prisma.$transaction(async (tx) => {
        await tx.campaign.update({
          where: { id: campaignId },
          data: { status: CampaignStatus.LIVE, escrowAccountId },
        });
        // Open a reconciliation row: the charge is confirmed and escrow funded,
        // but settlement is confirmed later by finance (§10).
        await tx.gatewayPayment.create({
          data: {
            campaignId,
            reference,
            expectedMinor: campaign.priceMinor as bigint,
            gatewayMinor: BigInt(v.amountMinor),
            ledgerTransactionId: transactionId,
          },
        });
        await this.audit.record(
          {
            actorId: userId,
            action: 'campaign.fund.paystack',
            entityType: 'campaign',
            entityId: campaignId,
            before: { status: campaign.status },
            after: { status: CampaignStatus.LIVE, amountMinor: campaign.priceMinor, reference },
            reason: `Paystack ${reference}`,
          },
          tx,
        );

        // Tell the owner their campaign is live (§notifications). dedupeKey shares the
        // admin manual-fund path's key, so a campaign is only ever announced live once.
        const org = await tx.clientOrg.findUnique({ where: { id: campaign.clientOrgId }, select: { ownerUserId: true } });
        if (org?.ownerUserId) {
          await this.notifications.create(
            {
              userId: org.ownerUserId,
              type: 'campaign.live',
              title: 'Campaign is live 🚀',
              body: `"${campaign.name}" is funded and live — we're now matching it to promoters. Track delivery from your dashboard.`,
              data: { campaignId },
              dedupeKey: `campaign.live:${campaignId}`,
            },
            tx,
          );
        }
      });
    }

    return { status: CampaignStatus.LIVE, message: 'Payment confirmed; your campaign is live.' };
  }
}
