import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountKind, CampaignStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { AuditService } from '../admin/audit.service';
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
  ) {}

  async verifyAndFund(userId: string, campaignId: string, reference: string): Promise<{ status: string; message: string }> {
    const org = await this.prisma.clientOrg.findFirst({ where: { ownerUserId: userId } });
    if (!org) throw new ForbiddenException('This account has no client organisation.');

    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign || campaign.clientOrgId !== org.id) throw new NotFoundException('No such campaign.');
    if (campaign.priceMinor === null) throw new BadRequestException('Get a quote before paying.');

    // Idempotency keyed on the Paystack reference itself: verifying the same
    // reference twice must never double-credit, whatever the request header says.
    const idempotencyKey = `paystack:${reference}`;
    if (await this.ledger.alreadyPosted(idempotencyKey)) {
      return { status: campaign.status, message: 'Payment already recorded.' };
    }

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

    const escrowAccountId =
      campaign.escrowAccountId ?? (await this.ledger.getOrCreateAccount(AccountKind.CAMPAIGN_ESCROW, campaignId));

    await this.ledger.fundCampaign({
      campaignId,
      escrowAccountId,
      amountMinor: campaign.priceMinor,
      idempotencyKey,
      actorId: userId,
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.campaign.update({
        where: { id: campaignId },
        data: { status: CampaignStatus.LIVE, escrowAccountId },
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
    });

    return { status: CampaignStatus.LIVE, message: 'Payment confirmed; your campaign is live.' };
  }
}
