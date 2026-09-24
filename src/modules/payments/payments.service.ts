import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AccountKind, Campaign, CampaignStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuditService } from '../admin/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { templates } from '../notifications/notification-templates';
import { formatNaira } from '../ledger/money';
import { MetaConversionsService } from '../../common/marketing/meta-conversions.service';
import { PaystackService } from './paystack.service';

/**
 * Browser-supplied context for mirroring the funding as a Meta `Purchase`
 * conversion server-side, deduplicated against the browser Pixel via event_id.
 * All optional; funding proceeds identically when absent.
 */
export type MetaPurchaseContext = {
  eventId?: string;
  fbp?: string;
  fbc?: string;
  eventSourceUrl?: string;
  clientIp?: string;
  userAgent?: string;
};

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
    private readonly meta: MetaConversionsService,
  ) {}

  private readonly logger = new Logger(PaymentsService.name);

  /** Client-initiated: verify the reference and fund the caller's own campaign. */
  async verifyAndFund(
    userId: string,
    campaignId: string,
    reference: string,
    meta?: MetaPurchaseContext,
  ): Promise<{ status: string; message: string }> {
    const org = await this.prisma.clientOrg.findFirst({ where: { ownerUserId: userId } });
    if (!org) throw new ForbiddenException('This account has no client organisation.');

    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.clientOrgId !== org.id) throw new NotFoundException('No such campaign.');

    return this.settleCharge(campaign, reference, userId, meta);
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
  private async settleCharge(
    campaign: Campaign,
    reference: string,
    actorId: string,
    meta?: MetaPurchaseContext,
  ): Promise<{ status: string; message: string }> {
    if (campaign.priceMinor === null) throw new BadRequestException('Get a quote before paying.');

    // Idempotency keyed on the Paystack reference itself: verifying the same
    // reference twice must never double-credit, whatever the request header says.
    const idempotencyKey = `paystack:${reference}`;
    if (await this.ledger.alreadyPosted(idempotencyKey)) {
      return { status: campaign.status, message: 'Payment already recorded.' };
    }

    // Order of operations (§approval): the client PAYS FIRST, which funds escrow and
    // sends the campaign to admin review (PENDING_APPROVAL). An admin then approves it
    // LIVE or rejects it (refunding). So a quoted campaign is what's fundable here;
    // paying never takes anything live on its own.
    const fundable: CampaignStatus[] = [CampaignStatus.QUOTED, CampaignStatus.CONFIRMING_PAYMENT];
    if (!fundable.includes(campaign.status)) {
      throw new ConflictException(`A ${campaign.status} campaign cannot be funded.`);
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

    // Only the first funding of this reference funds escrow, sends the campaign to
    // review and opens the reconciliation row — a concurrent replay must not re-audit
    // or collide on the unique reference. It does NOT go live: an admin decides that.
    if (!replayed) {
      await this.prisma.$transaction(async (tx) => {
        await tx.campaign.update({
          where: { id: campaignId },
          data: { status: CampaignStatus.PENDING_APPROVAL, escrowAccountId },
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
            after: { status: CampaignStatus.PENDING_APPROVAL, amountMinor: campaign.priceMinor, reference },
            reason: `Paystack ${reference}`,
          },
          tx,
        );
        // Receipt / acknowledgement: confirm the payment and the stage (under review).
        // No "campaign is live" email here — that fires when an admin approves it. The
        // recipient is the org owner (resolved here, since the webhook path's actorId
        // can be an org id, not a user id).
        const owner = await tx.clientOrg.findUnique({ where: { id: campaign.clientOrgId }, select: { ownerUserId: true } });
        if (owner?.ownerUserId) {
          const t = templates.campaignPaymentReceived(
            campaignId,
            campaign.name,
            formatNaira(campaign.priceMinor as bigint),
            campaign.slotsTotal,
            campaign.targetReach,
            reference,
          );
          await this.notifications.create(
            { userId: owner.ownerUserId, type: t.type, title: t.title, body: t.body, data: t.data, dedupeKey: `campaign.payment_received:${reference}` },
            tx,
          );
        }
      });

      // Mirror the funding to Meta as a server-side `Purchase` conversion. Only on
      // the first settle of this reference (never on a replay), and best-effort:
      // MetaConversionsService swallows its own errors, but we also guard here so a
      // lookup failure can't disturb a completed payment. The browser fires the same
      // Purchase with the same event_id, and Meta deduplicates the pair.
      await this.sendPurchaseConversion(campaign, reference, v.amountMinor, meta).catch((err) =>
        this.logger.warn(`Meta Purchase send skipped: ${(err as Error).message}`),
      );
    }

    return { status: CampaignStatus.PENDING_APPROVAL, message: 'Payment received — your campaign is now under review.' };
  }

  /**
   * Build and send the Meta `Purchase` conversion for a just-funded campaign.
   * event_id is the client's shared id when present (so the browser Pixel event
   * dedupes against this), else a deterministic `purchase:<reference>` so our own
   * retries/webhook backstop never double-count. Action source is 'website' when
   * the browser paid (we have a source URL), else 'system_generated' (webhook).
   */
  private async sendPurchaseConversion(
    campaign: Campaign,
    reference: string,
    amountMinor: number,
    meta?: MetaPurchaseContext,
  ): Promise<void> {
    if (!this.meta.configured) return;
    const org = await this.prisma.clientOrg.findUnique({
      where: { id: campaign.clientOrgId },
      select: { ownerUserId: true },
    });
    const owner = org?.ownerUserId
      ? await this.prisma.user.findUnique({
          where: { id: org.ownerUserId },
          select: { id: true, email: true, phoneE164: true },
        })
      : null;
    await this.meta.send({
      eventName: 'Purchase',
      eventId: meta?.eventId ?? `purchase:${reference}`,
      actionSource: meta?.eventSourceUrl ? 'website' : 'system_generated',
      eventSourceUrl: meta?.eventSourceUrl,
      user: {
        email: owner?.email,
        phone: owner?.phoneE164,
        externalId: owner?.id,
        clientIpAddress: meta?.clientIp,
        clientUserAgent: meta?.userAgent,
        fbp: meta?.fbp,
        fbc: meta?.fbc,
      },
      customData: {
        currency: 'NGN',
        value: Number(amountMinor) / 100,
        content_type: 'product',
        content_ids: [campaign.id],
        content_name: campaign.name,
        order_id: reference,
      },
    });
  }
}
