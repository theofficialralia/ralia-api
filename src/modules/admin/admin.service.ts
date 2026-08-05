import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  AccountKind,
  AssignmentStatus,
  CampaignStatus,
  ChannelStatus,
  ClientOrgStatus,
  EntryDirection,
  Prisma,
  PromoterStatus,
  ReconciliationStatus,
  Role,
  VerificationTier,
  Verdict,
  WithdrawalStatus,
} from '@prisma/client';
import { settleDelivery } from '../../common/pricing/pricing';
import { channelEffectiveReach } from '../../common/reach/effective-reach';
import { STORAGE, StorageProvider } from '../../common/storage/storage';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateConfigService } from '../../common/rate-config/rate-config.service';
import { AllocationService } from '../allocation/allocation.service';
import { LedgerService } from '../ledger/ledger.service';
import { formatNaira, toMoney } from '../ledger/money';
import { NotificationService } from '../notifications/notification.service';
import { ScoringService } from '../scoring/scoring.service';
import { AuditService } from './audit.service';
import { AdminDecisionDto, GatewayPaymentDto, RateConfigUpdateDto, ReconciliationReportDto } from './dto/admin.dto';

/**
 * Admin decisions. Everything here writes an audit row in the same transaction
 * as the change it records.
 *
 * The two capabilities the controller enforces are deliberately different in
 * kind: REVIEW_EVIDENCE covers judgements about content and people, while
 * RECORD_MONEY covers attestations that real-world money moved (§5.6 — the admin
 * marks a campaign funded because the client's bank transfer arrived, and marks
 * a withdrawal paid because they sent one).
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly rateConfig: RateConfigService,
    private readonly scoring: ScoringService,
    private readonly allocation: AllocationService,
    private readonly notifications: NotificationService,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  /** Admin-triggered hybrid allocation pass (§8) — one round of best-fit offers. */
  async allocateCampaign(adminId: string, campaignId: string) {
    const result = await this.allocation.allocateCampaign(campaignId, new Date());
    await this.audit.record({
      actorId: adminId,
      action: 'campaign.allocate',
      entityType: 'campaign',
      entityId: campaignId,
      after: { phase: result.phase, openSlots: result.openSlots, sent: result.sent },
    });
    return result;
  }

  // ── Users ────────────────────────────────────────────────

  async approvePromoter(adminId: string, userId: string): Promise<AdminDecisionDto> {
    const profile = await this.prisma.promoterProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('No promoter profile for that user.');
    if (profile.status === PromoterStatus.ACTIVE) {
      throw new ConflictException('That promoter is already approved.');
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Channels first, so computeCapability sees them ACTIVE for the reach factor.
      await tx.channel.updateMany({
        where: { promoterId: userId, status: ChannelStatus.PENDING_REVIEW },
        data: { status: ChannelStatus.ACTIVE },
      });
      // §3 capability, confirmed at the review step: compute per-role from the
      // promoter's self-reported factors + derived reach/proof, and freeze it.
      const capabilityScores = await this.scoring.computeCapability(userId, {}, tx);
      await tx.promoterProfile.update({
        where: { userId },
        data: {
          status: PromoterStatus.ACTIVE,
          approvedBy: adminId,
          approvedAt: now,
          capabilityScores,
          capabilityConfirmedBy: adminId,
          capabilityConfirmedAt: now,
        },
      });
      await this.notifications.create(
        {
          userId,
          type: 'promoter.approved',
          title: "You're approved 🎉",
          body: 'Your promoter profile is approved. Offers matched to your channels will start appearing in the app.',
          data: {},
        },
        tx,
      );
      await this.audit.record(
        {
          actorId: adminId,
          action: 'promoter.approve',
          entityType: 'promoter_profile',
          entityId: userId,
          before: { status: profile.status },
          after: { status: PromoterStatus.ACTIVE },
        },
        tx,
      );
    });

    return { id: userId, status: PromoterStatus.ACTIVE, message: 'Promoter approved.' };
  }

  /** Admin override of computed per-role capability (§3). Merges over existing scores. */
  async setCapability(adminId: string, userId: string, scores: Record<string, number>): Promise<AdminDecisionDto> {
    const profile = await this.prisma.promoterProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('No promoter profile for that user.');

    const valid = ['DISTRIBUTOR', 'CREATOR', 'PARTICIPATOR', 'INFLUENCER'];
    const clean: Record<string, number> = {};
    for (const [role, v] of Object.entries(scores)) {
      if (!valid.includes(role)) throw new BadRequestException(`Unknown role: ${role}`);
      if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 100) {
        throw new BadRequestException(`Capability for ${role} must be a number in [0, 100].`);
      }
      clean[role] = Math.round(v);
    }

    const merged = { ...((profile.capabilityScores as Record<string, number> | null) ?? {}), ...clean };
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.promoterProfile.update({
        where: { userId },
        data: { capabilityScores: merged, capabilityConfirmedBy: adminId, capabilityConfirmedAt: now },
      });
      await this.audit.record(
        {
          actorId: adminId,
          action: 'promoter.capability.override',
          entityType: 'promoter_profile',
          entityId: userId,
          before: { capabilityScores: profile.capabilityScores },
          after: { capabilityScores: merged },
        },
        tx,
      );
    });

    return { id: userId, status: profile.status, message: 'Capability updated.' };
  }

  async rejectPromoter(adminId: string, userId: string, reason: string): Promise<AdminDecisionDto> {
    const profile = await this.prisma.promoterProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('No promoter profile for that user.');

    await this.prisma.$transaction(async (tx) => {
      await tx.promoterProfile.update({ where: { userId }, data: { status: PromoterStatus.REJECTED } });
      await this.notifications.create(
        {
          userId,
          type: 'promoter.rejected',
          title: 'Profile needs changes',
          body: `We couldn't approve your profile yet: ${reason} Update it and resubmit for review.`,
          data: { reason },
        },
        tx,
      );
      await this.audit.record(
        {
          actorId: adminId,
          action: 'promoter.reject',
          entityType: 'promoter_profile',
          entityId: userId,
          before: { status: profile.status },
          after: { status: PromoterStatus.REJECTED },
          reason,
        },
        tx,
      );
    });

    return { id: userId, status: PromoterStatus.REJECTED, message: 'Promoter rejected.' };
  }

  // ── Campaigns ────────────────────────────────────────────

  /** The client user who owns a campaign — the recipient of campaign notifications. */
  private async campaignOwnerId(clientOrgId: string): Promise<string | null> {
    const org = await this.prisma.clientOrg.findUnique({
      where: { id: clientOrgId },
      select: { ownerUserId: true },
    });
    return org?.ownerUserId ?? null;
  }

  async approveCampaign(adminId: string, campaignId: string): Promise<AdminDecisionDto> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new NotFoundException('No such campaign.');
    if (campaign.status !== CampaignStatus.PENDING_APPROVAL) {
      throw new ConflictException(`A ${campaign.status} campaign is not awaiting approval.`);
    }

    const ownerId = await this.campaignOwnerId(campaign.clientOrgId);
    await this.prisma.$transaction(async (tx) => {
      await tx.campaign.update({
        where: { id: campaignId },
        // Approved, now awaiting the client's transfer — funding flips it LIVE.
        data: { status: CampaignStatus.CONFIRMING_PAYMENT, approvedBy: adminId, approvedAt: new Date() },
      });
      if (ownerId) {
        await this.notifications.create(
          {
            userId: ownerId,
            type: 'campaign.approved',
            title: 'Campaign approved',
            body: `"${campaign.name}" is approved. Fund it with the quoted amount to take it live and start matching promoters.`,
            data: { campaignId },
            dedupeKey: `campaign.approved:${campaignId}`,
          },
          tx,
        );
      }
      await this.audit.record(
        {
          actorId: adminId,
          action: 'campaign.approve',
          entityType: 'campaign',
          entityId: campaignId,
          before: { status: campaign.status },
          after: { status: CampaignStatus.CONFIRMING_PAYMENT },
        },
        tx,
      );
    });

    return { id: campaignId, status: CampaignStatus.CONFIRMING_PAYMENT, message: 'Campaign approved; awaiting payment.' };
  }

  async rejectCampaign(adminId: string, campaignId: string, reason: string): Promise<AdminDecisionDto> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new NotFoundException('No such campaign.');
    if (campaign.status !== CampaignStatus.PENDING_APPROVAL) {
      throw new ConflictException(`A ${campaign.status} campaign is not awaiting approval.`);
    }

    const ownerId = await this.campaignOwnerId(campaign.clientOrgId);
    await this.prisma.$transaction(async (tx) => {
      await tx.campaign.update({ where: { id: campaignId }, data: { status: CampaignStatus.REJECTED, rejectReason: reason } });
      if (ownerId) {
        await this.notifications.create(
          {
            userId: ownerId,
            type: 'campaign.rejected',
            title: 'Campaign needs changes',
            body: `"${campaign.name}" wasn't approved: ${reason} Edit and resubmit it for review.`,
            data: { campaignId, reason },
            dedupeKey: `campaign.rejected:${campaignId}`,
          },
          tx,
        );
      }
      await this.audit.record(
        {
          actorId: adminId,
          action: 'campaign.reject',
          entityType: 'campaign',
          entityId: campaignId,
          before: { status: campaign.status },
          after: { status: CampaignStatus.REJECTED },
          reason,
        },
        tx,
      );
    });

    return { id: campaignId, status: CampaignStatus.REJECTED, message: 'Campaign rejected.' };
  }

  /**
   * Record that the client's bank transfer arrived: DR BANK_CLEARING /
   * CR CAMPAIGN_ESCROW, and the campaign goes LIVE. There is no payment gateway
   * in this MVP (§11) — this is an attestation by the admin, and the ledger keeps
   * the arithmetic exact regardless.
   */
  async fundCampaign(
    adminId: string,
    campaignId: string,
    amountMinor: bigint,
    idempotencyKey: string,
    reference?: string,
  ): Promise<AdminDecisionDto> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new NotFoundException('No such campaign.');

    // Idempotency before state. A retry of a funding that already succeeded must
    // return that success — the campaign is LIVE precisely *because* of the first
    // attempt, so the status guard below would otherwise reject the client's
    // honest retry with a 409.
    if (await this.ledger.alreadyPosted(idempotencyKey)) {
      return { id: campaignId, status: campaign.status, message: 'Already recorded.' };
    }

    if (campaign.status !== CampaignStatus.CONFIRMING_PAYMENT) {
      throw new ConflictException(`A ${campaign.status} campaign is not awaiting funding.`);
    }
    if (campaign.priceMinor === null) {
      throw new BadRequestException('This campaign has no quoted price.');
    }
    if (amountMinor !== campaign.priceMinor) {
      // Partial funding would leave escrow unable to cover the slots it sold.
      throw new BadRequestException(
        `Amount must equal the quoted price of ${campaign.priceMinor} kobo (got ${amountMinor}).`,
      );
    }

    const escrowAccountId =
      campaign.escrowAccountId ?? (await this.ledger.getOrCreateAccount(AccountKind.CAMPAIGN_ESCROW, campaignId));

    const { replayed } = await this.ledger.fundCampaign({
      campaignId,
      escrowAccountId,
      amountMinor,
      idempotencyKey,
      actorId: adminId,
    });

    if (!replayed) {
      const ownerId = await this.campaignOwnerId(campaign.clientOrgId);
      await this.prisma.$transaction(async (tx) => {
        await tx.campaign.update({
          where: { id: campaignId },
          data: { status: CampaignStatus.LIVE, escrowAccountId },
        });
        if (ownerId) {
          await this.notifications.create(
            {
              userId: ownerId,
              type: 'campaign.live',
              title: 'Campaign is live 🚀',
              body: `"${campaign.name}" is funded and live — we're now matching it to promoters. Track delivery from your dashboard.`,
              data: { campaignId },
              dedupeKey: `campaign.live:${campaignId}`,
            },
            tx,
          );
        }
        await this.audit.record(
          {
            actorId: adminId,
            action: 'campaign.fund',
            entityType: 'campaign',
            entityId: campaignId,
            before: { status: campaign.status, escrowAccountId: campaign.escrowAccountId },
            after: { status: CampaignStatus.LIVE, escrowAccountId, amountMinor },
            reason: reference,
          },
          tx,
        );
      });
    }

    return { id: campaignId, status: CampaignStatus.LIVE, message: replayed ? 'Already recorded.' : 'Funding recorded; campaign is live.' };
  }

  // ── Submissions ──────────────────────────────────────────

  /**
   * Approve proof and pay the promoter pro-rata on the verified views
   * (ALGORITHMS.md §2). The delivered fee, Ralia's take, and the client's refund
   * of the undelivered remainder all move in ONE balanced transaction, so escrow
   * settles to exactly what it held for the slot and a retry can't strand any leg.
   *
   * A delivery below the threshold cannot be approved here — it is rejected so the
   * promoter can resubmit, which is the §2 delivery floor.
   */
  async approveSubmission(
    adminId: string,
    submissionId: string,
    verifiedViews: number,
    idempotencyKey: string,
  ): Promise<AdminDecisionDto> {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: { assignment: { include: { campaign: true } } },
    });
    if (!submission) throw new NotFoundException('No such submission.');

    // Idempotency before state, for the same reason as funding: this submission
    // is APPROVED because the first attempt worked, and a retry must be told so
    // rather than refused.
    if (await this.ledger.alreadyPosted(idempotencyKey)) {
      return { id: submissionId, status: submission.verdict, message: 'Already recorded.' };
    }

    if (submission.verdict !== Verdict.PENDING) {
      throw new ConflictException(`This submission is already ${submission.verdict.toLowerCase()}.`);
    }

    const assignment = submission.assignment;
    const campaign = assignment.campaign;
    if (!campaign.escrowAccountId) {
      throw new BadRequestException('This campaign was never funded — there is nothing to pay from.');
    }
    if (assignment.promisedReach <= 0) {
      throw new BadRequestException('This assignment has no promised reach recorded, so it cannot be settled pro-rata.');
    }

    const config = await this.rateConfig.getSettlementConfig();
    const settlement = settleDelivery(assignment.grossMinor, verifiedViews, assignment.promisedReach, config);

    // The §2 delivery floor: below the threshold, approval is refused so the
    // promoter can resubmit rather than be part-paid for an under-delivery.
    if (!settlement.meetsThreshold) {
      throw new BadRequestException(
        `Verified ${verifiedViews} views is below the ${config.deliveryThresholdPct}% threshold of the promised ${assignment.promisedReach}. Reject this submission so the promoter can resubmit.`,
      );
    }

    const promoterAccountId = await this.ledger.getOrCreateAccount(
      AccountKind.PROMOTER_AVAILABLE,
      assignment.promoterId,
    );
    const clientWalletAccountId = await this.ledger.getOrCreateAccount(
      AccountKind.CLIENT_WALLET,
      campaign.clientOrgId,
    );

    // Fee, take and the undelivered refund all move out of escrow together.
    const { replayed } = await this.ledger.settleSubmission({
      submissionId,
      escrowAccountId: campaign.escrowAccountId,
      promoterAccountId,
      clientWalletAccountId,
      feeMinor: settlement.promoterFeeMinor,
      takeMinor: settlement.raliaTakeMinor,
      refundMinor: settlement.refundMinor,
      idempotencyKey,
      actorId: adminId,
    });

    if (!replayed) {
      const now = new Date();
      // On-time = the approved submission landed by the delivery deadline. No deadline
      // set → treat as on-time (nothing to be late against). Drives the trust delta (§4)
      // and the reliability cache (§5).
      const deliveredOnTime = assignment.dueAt === null || submission.submittedAt <= assignment.dueAt;
      await this.prisma.$transaction(async (tx) => {
        await tx.submission.update({
          where: { id: submissionId },
          data: { verdict: Verdict.APPROVED, verifiedReach: verifiedViews, reviewedBy: adminId, reviewedAt: now },
        });
        await tx.assignment.update({
          where: { id: assignment.id },
          data: { status: AssignmentStatus.PAID, paidAt: now, deliveredOnTime },
        });
        await this.scoring.recordDeliveryOutcome(
          assignment.promoterId,
          deliveredOnTime ? 'ON_TIME_DELIVERY' : 'LATE_DELIVERY',
          now,
          tx,
        );
        // Notify in the same tx as the payout — the promoter must never be paid
        // without the record of why.
        await this.notifications.create(
          {
            userId: assignment.promoterId,
            type: 'submission.approved',
            title: 'Submission approved — you got paid',
            body: `Your proof for "${campaign.name}" was approved. ${formatNaira(settlement.promoterFeeMinor)} has been added to your balance.`,
            data: { submissionId, campaignId: campaign.id, feeMinor: Number(settlement.promoterFeeMinor) },
            dedupeKey: `submission.approved:${submissionId}`,
          },
          tx,
        );
        await this.audit.record(
          {
            actorId: adminId,
            action: 'submission.approve',
            entityType: 'submission',
            entityId: submissionId,
            before: { verdict: Verdict.PENDING, assignmentStatus: assignment.status },
            after: {
              verdict: Verdict.APPROVED,
              assignmentStatus: AssignmentStatus.PAID,
              verifiedReach: verifiedViews,
              promisedReach: assignment.promisedReach,
              feeMinor: settlement.promoterFeeMinor,
              takeMinor: settlement.raliaTakeMinor,
              refundMinor: settlement.refundMinor,
            },
          },
          tx,
        );
      });
    }

    return { id: submissionId, status: Verdict.APPROVED, message: replayed ? 'Already recorded.' : 'Approved and settled.' };
  }

  async rejectSubmission(adminId: string, submissionId: string, reason: string): Promise<AdminDecisionDto> {
    const submission = await this.prisma.submission.findUnique({
      where: { id: submissionId },
      include: { assignment: true },
    });
    if (!submission) throw new NotFoundException('No such submission.');
    if (submission.verdict !== Verdict.PENDING) {
      throw new ConflictException(`This submission is already ${submission.verdict.toLowerCase()}.`);
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.submission.update({
        where: { id: submissionId },
        data: { verdict: Verdict.REJECTED, reviewedBy: adminId, reviewedAt: now, rejectReason: reason },
      });
      // Back to REJECTED so the promoter can submit again — a rejection is
      // feedback, not the end of the assignment.
      await tx.assignment.update({
        where: { id: submission.assignmentId },
        data: { status: AssignmentStatus.REJECTED },
      });
      // A rejected submission dings trust (−6, §4). The assignment stays open, so
      // this does not touch the completed/reliability counts.
      await this.scoring.recordDeliveryOutcome(submission.assignment.promoterId, 'REJECTED', now, tx);
      await this.notifications.create(
        {
          userId: submission.assignment.promoterId,
          type: 'submission.rejected',
          title: 'Submission needs another look',
          body: `Your proof was rejected: ${reason} You can resubmit before the deadline.`,
          data: { submissionId, reason },
          dedupeKey: `submission.rejected:${submissionId}`,
        },
        tx,
      );
      await this.audit.record(
        {
          actorId: adminId,
          action: 'submission.reject',
          entityType: 'submission',
          entityId: submissionId,
          before: { verdict: Verdict.PENDING },
          after: { verdict: Verdict.REJECTED },
          reason,
        },
        tx,
      );
    });

    return { id: submissionId, status: Verdict.REJECTED, message: 'Rejected.' };
  }

  // ── Withdrawals ──────────────────────────────────────────

  async approveWithdrawal(adminId: string, withdrawalId: string): Promise<AdminDecisionDto> {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) throw new NotFoundException('No such withdrawal.');
    if (withdrawal.status !== WithdrawalStatus.REQUESTED) {
      throw new ConflictException(`This withdrawal is ${withdrawal.status.toLowerCase()}.`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: WithdrawalStatus.APPROVED, approvedBy: adminId },
      });
      await this.notifications.create(
        {
          userId: withdrawal.promoterId,
          type: 'withdrawal.approved',
          title: 'Withdrawal approved',
          body: `Your withdrawal of ${formatNaira(withdrawal.amountMinor)} was approved and the transfer is on its way to your bank.`,
          data: { withdrawalId, amountMinor: Number(withdrawal.amountMinor) },
          dedupeKey: `withdrawal.approved:${withdrawalId}`,
        },
        tx,
      );
      await this.audit.record(
        {
          actorId: adminId,
          action: 'withdrawal.approve',
          entityType: 'withdrawal',
          entityId: withdrawalId,
          before: { status: withdrawal.status },
          after: { status: WithdrawalStatus.APPROVED, amountMinor: withdrawal.amountMinor },
        },
        tx,
      );
    });

    return { id: withdrawalId, status: WithdrawalStatus.APPROVED, message: 'Withdrawal approved; send the transfer, then record it.' };
  }

  /**
   * Record that the admin actually sent the promoter's bank transfer:
   * DR PROMOTER_AVAILABLE / CR BANK_CLEARING.
   */
  async recordWithdrawalPaid(
    adminId: string,
    withdrawalId: string,
    paidRef: string,
    idempotencyKey: string,
  ): Promise<AdminDecisionDto> {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) throw new NotFoundException('No such withdrawal.');

    // Idempotency before state — see fundCampaign.
    if (await this.ledger.alreadyPosted(idempotencyKey)) {
      return { id: withdrawalId, status: withdrawal.status, message: 'Already recorded.' };
    }

    if (withdrawal.status !== WithdrawalStatus.APPROVED) {
      throw new ConflictException(`Only an approved withdrawal can be recorded as paid (this one is ${withdrawal.status.toLowerCase()}).`);
    }

    const promoterAccountId = await this.ledger.getOrCreateAccount(
      AccountKind.PROMOTER_AVAILABLE,
      withdrawal.promoterId,
    );

    const { replayed } = await this.ledger.payWithdrawal({
      withdrawalId,
      promoterAccountId,
      amountMinor: withdrawal.amountMinor,
      idempotencyKey,
      actorId: adminId,
    });

    if (!replayed) {
      await this.prisma.$transaction(async (tx) => {
        await tx.withdrawal.update({
          where: { id: withdrawalId },
          data: { status: WithdrawalStatus.PAID, paidRef },
        });
        await this.audit.record(
          {
            actorId: adminId,
            action: 'withdrawal.paid',
            entityType: 'withdrawal',
            entityId: withdrawalId,
            before: { status: WithdrawalStatus.APPROVED },
            after: { status: WithdrawalStatus.PAID, paidRef, amountMinor: withdrawal.amountMinor },
          },
          tx,
        );
      });
    }

    return { id: withdrawalId, status: WithdrawalStatus.PAID, message: replayed ? 'Already recorded.' : 'Payout recorded.' };
  }

  // ── Queues ───────────────────────────────────────────────
  // Thin: plain lists of what needs a decision. Filtering and pagination are
  // the harden slice.
  //
  // Every amount is mapped through toMoney(): raw Prisma rows carry bigint money
  // columns, which serialise only by virtue of a global prototype patch and
  // would reach the client as bare strings rather than the {amount_minor,
  // amount_display} pair §2 requires.

  async pendingPromoters() {
    const rows = await this.prisma.promoterProfile.findMany({
      where: { status: PromoterStatus.AWAITING_APPROVAL },
      include: {
        user: {
          select: {
            email: true,
            phoneE164: true,
            channels: {
              orderBy: { effectiveReach: 'desc' },
              select: {
                id: true, platform: true, handle: true, url: true, claimedAudience: true,
                effectiveReach: true, verificationTier: true, verifiedAt: true,
                isGroup: true, groupMembers: true, activeParticipants: true, status: true,
              },
            },
          },
        },
      },
      orderBy: { updatedAt: 'asc' },
    });
    return rows.map((p) => ({
      user_id: p.userId,
      full_name: p.fullName,
      location_state: p.locationState,
      trust_score: p.trustScore.toNumber(),
      email: p.user.email,
      phone_e164: p.user.phoneE164,
      // The admin checks these against the claimed reach before approving (§5.3).
      channels: p.user.channels.map((c) => ({
        id: c.id,
        platform: c.platform,
        handle: c.handle,
        url: c.url,
        claimed_audience: c.claimedAudience,
        effective_reach: c.effectiveReach,
        verification_tier: c.verificationTier,
        verified_at: c.verifiedAt?.toISOString() ?? null,
        is_group: c.isGroup,
        group_members: c.groupMembers,
        active_participants: c.activeParticipants,
        status: c.status,
      })),
    }));
  }

  async pendingCampaigns() {
    const rows = await this.prisma.campaign.findMany({
      where: { status: { in: [CampaignStatus.PENDING_APPROVAL, CampaignStatus.CONFIRMING_PAYMENT] } },
      orderBy: { updatedAt: 'asc' },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      objective: c.objective,
      slots_total: c.slotsTotal,
      price: c.priceMinor === null ? null : toMoney(c.priceMinor),
    }));
  }

  /** Live/paused campaigns — the ones the admin matches promoters to. */
  async liveCampaigns() {
    const rows = await this.prisma.campaign.findMany({
      where: { status: { in: [CampaignStatus.LIVE, CampaignStatus.PAUSED] } },
      orderBy: { updatedAt: 'desc' },
      include: { clientOrg: { select: { name: true } } },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      objective: c.objective,
      slots_total: c.slotsTotal,
      slots_filled: c.slotsFilled,
      client_name: c.clientOrg.name,
      price: c.priceMinor === null ? null : toMoney(c.priceMinor),
    }));
  }

  /** Full campaign for the admin review panel and matching context. */
  async campaignDetail(campaignId: string) {
    const c = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        clientOrg: { select: { id: true, name: true, industry: true } },
        targeting: true,
        assets: { orderBy: { orderIndex: 'asc' }, select: { id: true, kind: true, captionText: true, fileId: true } },
      },
    });
    if (!c) throw new NotFoundException('No such campaign.');
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      objective: c.objective,
      description: c.description,
      promoter_instructions: c.promoterInstructions,
      destination_url: c.destinationUrl,
      needs_creative: c.needsCreative,
      slots_total: c.slotsTotal,
      slots_filled: c.slotsFilled,
      price: c.priceMinor === null ? null : toMoney(c.priceMinor),
      budget: toMoney(c.budgetMinor),
      quoted_at: c.quotedAt?.toISOString() ?? null,
      starts_at: c.startsAt?.toISOString() ?? null,
      ends_at: c.endsAt?.toISOString() ?? null,
      client: { org_id: c.clientOrg.id, name: c.clientOrg.name, industry: c.clientOrg.industry },
      targeting: c.targeting
        ? {
            states: c.targeting.states,
            lgas: c.targeting.lgas,
            age_min: c.targeting.ageMin,
            age_max: c.targeting.ageMax,
            genders: c.targeting.genders,
            languages: c.targeting.languages,
            categories: c.targeting.categories,
            platforms: c.targeting.platforms,
            min_effective_reach: c.targeting.minEffectiveReach,
            roles: c.targeting.roles,
          }
        : null,
      assets: c.assets.map((a) => ({ id: a.id, kind: a.kind, caption_text: a.captionText, file_id: a.fileId })),
    };
  }

  async pendingSubmissions() {
    const rows = await this.prisma.submission.findMany({
      where: { verdict: Verdict.PENDING },
      include: {
        artifacts: { select: { id: true, reuseOfId: true, file: { select: { storageKey: true } } } },
        assignment: {
          select: {
            id: true,
            campaignId: true,
            promoterId: true,
            feeMinor: true,
            promisedReach: true,
            campaign: { select: { name: true, objective: true } },
            promoter: { select: { promoterProfile: { select: { fullName: true } } } },
          },
        },
      },
      orderBy: { submittedAt: 'asc' },
    });
    return Promise.all(
      rows.map(async (s) => {
        const primary = s.artifacts[0];
        return {
          id: s.id,
          assignment_id: s.assignmentId,
          campaign_id: s.assignment.campaignId,
          campaign_name: s.assignment.campaign.name,
          objective: s.assignment.campaign.objective,
          promoter_id: s.assignment.promoterId,
          promoter_name: s.assignment.promoter.promoterProfile?.fullName ?? null,
          fee: toMoney(s.assignment.feeMinor),
          promised_reach: s.assignment.promisedReach,
          claimed_views: s.claimedViews,
          auto_flag: s.autoFlag,
          public_url: s.publicUrl,
          note: s.note,
          // Signed URL so the admin can open the actual screenshot to verify the count.
          image_url: primary?.file ? await this.storage.signedUrl(primary.file.storageKey) : null,
          submitted_at: s.submittedAt.toISOString(),
          // reuse_of_id tells the admin this screenshot perceptually matched an earlier one.
          artifacts: s.artifacts.map((a) => ({ id: a.id, reuse_of_id: a.reuseOfId })),
        };
      }),
    );
  }

  async pendingWithdrawals() {
    const rows = await this.prisma.withdrawal.findMany({
      where: { status: { in: [WithdrawalStatus.REQUESTED, WithdrawalStatus.APPROVED] } },
      include: {
        promoter: { select: { promoterProfile: { select: { fullName: true } } } },
        bankAccount: { select: { accountName: true, accountNumberLast4: true, bankCode: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((w) => ({
      id: w.id,
      promoter_id: w.promoterId,
      promoter_name: w.promoter.promoterProfile?.fullName ?? null,
      amount: toMoney(w.amountMinor),
      status: w.status,
      bank: { account_name: w.bankAccount.accountName, last4: w.bankAccount.accountNumberLast4, bank_code: w.bankAccount.bankCode },
      created_at: w.createdAt.toISOString(),
    }));
  }

  // ── Channels: verification (§1) ──────────────────────────

  /**
   * Verify a channel's audience evidence and set its tier. This lifts the
   * self-reported cap and stamps verified_at, which starts the proof-decay clock
   * (ALGORITHMS.md §1). Reach is recomputed in the same transaction as the tier
   * change so the stored value can never lag the tier it was priced from.
   */
  async verifyChannel(adminId: string, channelId: string, tier: VerificationTier): Promise<AdminDecisionDto> {
    if (tier === VerificationTier.SELF) {
      throw new BadRequestException('Verify sets a proven tier; use unverify to drop a channel to self-reported.');
    }
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('No such channel.');

    const now = new Date();
    const policy = await this.rateConfig.getReachPolicy();
    const effectiveReach = channelEffectiveReach(
      { platform: channel.platform, claimedAudience: channel.claimedAudience, isGroup: channel.isGroup, activeParticipants: channel.activeParticipants, verificationTier: tier, verifiedAt: now },
      policy,
      now,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.channel.update({
        where: { id: channelId },
        data: { verificationTier: tier, verifiedAt: now, effectiveReach },
      });
      await this.audit.record(
        {
          actorId: adminId,
          action: 'channel.verify',
          entityType: 'channel',
          entityId: channelId,
          before: { verificationTier: channel.verificationTier, effectiveReach: channel.effectiveReach },
          after: { verificationTier: tier, effectiveReach, verifiedAt: now.toISOString() },
        },
        tx,
      );
    });

    return { id: channelId, status: tier, message: `Channel verified at ${tier}.` };
  }

  /** Drop a channel back to self-reported (bad or stale proof): clears verified_at and re-caps reach. */
  async unverifyChannel(adminId: string, channelId: string, reason: string): Promise<AdminDecisionDto> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('No such channel.');

    const now = new Date();
    const policy = await this.rateConfig.getReachPolicy();
    const effectiveReach = channelEffectiveReach(
      { platform: channel.platform, claimedAudience: channel.claimedAudience, isGroup: channel.isGroup, activeParticipants: channel.activeParticipants, verificationTier: VerificationTier.SELF, verifiedAt: null },
      policy,
      now,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.channel.update({
        where: { id: channelId },
        data: { verificationTier: VerificationTier.SELF, verifiedAt: null, effectiveReach },
      });
      await this.audit.record(
        {
          actorId: adminId,
          action: 'channel.unverify',
          entityType: 'channel',
          entityId: channelId,
          before: { verificationTier: channel.verificationTier, effectiveReach: channel.effectiveReach },
          after: { verificationTier: VerificationTier.SELF, effectiveReach },
          reason,
        },
        tx,
      );
    });

    return { id: channelId, status: VerificationTier.SELF, message: 'Channel dropped to self-reported.' };
  }

  // ── Gateway reconciliation (§10) ─────────────────────────

  /**
   * Reconcile every gateway charge against the ledger: each row shows the price
   * the charge was for, what the gateway reported, and the escrow credit the
   * ledger actually holds — the three should agree. `matched` is false the moment
   * any two diverge; `ledger_matches_gateway` is the overall proof.
   */
  async reconciliationReport(): Promise<ReconciliationReportDto> {
    const payments = await this.prisma.gatewayPayment.findMany({ orderBy: { createdAt: 'desc' } });

    const txIds = payments.map((p) => p.ledgerTransactionId).filter((id): id is string => id !== null);
    const credits = txIds.length
      ? await this.prisma.ledgerEntry.groupBy({
          by: ['transactionId'],
          where: { transactionId: { in: txIds }, direction: EntryDirection.CREDIT },
          _sum: { amountMinor: true },
        })
      : [];
    const ledgerByTx = new Map(credits.map((c) => [c.transactionId, c._sum.amountMinor ?? 0n]));

    let gatewayTotal = 0n;
    let settledTotal = 0n;
    let allMatch = true;
    const counts = { recorded: 0, settled: 0, mismatched: 0 };

    const rows: GatewayPaymentDto[] = payments.map((p) => {
      const ledgerMinor = p.ledgerTransactionId ? ledgerByTx.get(p.ledgerTransactionId) ?? 0n : 0n;
      const matched = ledgerMinor === p.gatewayMinor;
      if (!matched) allMatch = false;
      gatewayTotal += p.gatewayMinor;
      settledTotal += p.settledMinor ?? 0n;
      if (p.status === ReconciliationStatus.RECORDED) counts.recorded++;
      else if (p.status === ReconciliationStatus.SETTLED) counts.settled++;
      else counts.mismatched++;

      return {
        id: p.id,
        campaign_id: p.campaignId,
        reference: p.reference,
        expected: toMoney(p.expectedMinor),
        gateway: toMoney(p.gatewayMinor),
        ledger: toMoney(ledgerMinor),
        matched,
        status: p.status,
        settled: p.settledMinor === null ? null : toMoney(p.settledMinor),
        settlement_ref: p.settlementRef,
        settled_at: p.settledAt?.toISOString() ?? null,
      };
    });

    return {
      gateway_total: toMoney(gatewayTotal),
      settled_total: toMoney(settledTotal),
      ledger_matches_gateway: allMatch,
      recorded: counts.recorded,
      settled: counts.settled,
      mismatched: counts.mismatched,
      payments: rows,
    };
  }

  /** Confirm a gateway settlement cleared: RECORDED → SETTLED. */
  async settleGatewayPayment(adminId: string, id: string, settlementRef: string, settledMinor: bigint): Promise<AdminDecisionDto> {
    const gp = await this.prisma.gatewayPayment.findUnique({ where: { id } });
    if (!gp) throw new NotFoundException('No such gateway payment.');
    if (gp.status !== ReconciliationStatus.RECORDED) {
      throw new ConflictException(`This payment is already ${gp.status.toLowerCase()}.`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.gatewayPayment.update({
        where: { id },
        data: { status: ReconciliationStatus.SETTLED, settlementRef, settledMinor, settledBy: adminId, settledAt: new Date() },
      });
      await this.audit.record(
        {
          actorId: adminId,
          action: 'gateway.settle',
          entityType: 'gateway_payment',
          entityId: id,
          before: { status: gp.status },
          after: { status: ReconciliationStatus.SETTLED, settlementRef, settledMinor },
        },
        tx,
      );
    });

    return { id, status: ReconciliationStatus.SETTLED, message: 'Settlement recorded.' };
  }

  /** Flag a settlement discrepancy for finance: → MISMATCH. */
  async flagGatewayPayment(adminId: string, id: string, reason: string): Promise<AdminDecisionDto> {
    const gp = await this.prisma.gatewayPayment.findUnique({ where: { id } });
    if (!gp) throw new NotFoundException('No such gateway payment.');
    if (gp.status === ReconciliationStatus.MISMATCH) {
      throw new ConflictException('This payment is already flagged.');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.gatewayPayment.update({ where: { id }, data: { status: ReconciliationStatus.MISMATCH, note: reason } });
      await this.audit.record(
        {
          actorId: adminId,
          action: 'gateway.flag',
          entityType: 'gateway_payment',
          entityId: id,
          before: { status: gp.status },
          after: { status: ReconciliationStatus.MISMATCH },
          reason,
        },
        tx,
      );
    });

    return { id, status: ReconciliationStatus.MISMATCH, message: 'Flagged for finance.' };
  }

  // ── Clients ──────────────────────────────────────────────

  async clients() {
    const orgs = await this.prisma.clientOrg.findMany({
      orderBy: { createdAt: 'desc' },
      include: { owner: { select: { email: true } }, _count: { select: { campaigns: true } } },
    });
    const spent = await this.prisma.campaign.groupBy({
      by: ['clientOrgId'],
      where: { status: { in: FUNDED_STATUSES }, priceMinor: { not: null } },
      _sum: { priceMinor: true },
    });
    const spentByOrg = new Map(spent.map((s) => [s.clientOrgId, s._sum.priceMinor ?? 0n]));
    return orgs.map((o) => ({
      org_id: o.id,
      name: o.name,
      email: o.owner.email,
      industry: o.industry,
      status: o.status,
      campaigns_created: o._count.campaigns,
      spent: toMoney(spentByOrg.get(o.id) ?? 0n),
      created_at: o.createdAt.toISOString(),
    }));
  }

  async setClientStatus(adminId: string, orgId: string, status: ClientOrgStatus): Promise<AdminDecisionDto> {
    const org = await this.prisma.clientOrg.findUnique({ where: { id: orgId } });
    if (!org) throw new NotFoundException('No such client.');
    await this.prisma.$transaction(async (tx) => {
      await tx.clientOrg.update({ where: { id: orgId }, data: { status } });
      await this.audit.record(
        {
          actorId: adminId,
          action: status === ClientOrgStatus.SUSPENDED ? 'client.deactivate' : 'client.reactivate',
          entityType: 'client_org',
          entityId: orgId,
          before: { status: org.status },
          after: { status },
        },
        tx,
      );
    });
    return { id: orgId, status, message: status === ClientOrgStatus.SUSPENDED ? 'Client deactivated.' : 'Client reactivated.' };
  }

  // ── Settings: platform rules, audit log, team ────────────

  async platformRules() {
    const c = await this.rateConfig.getActive();
    return {
      rpm_minor: c.rpmMinor,
      take_rate_pct: Math.round(c.takeRate.toNumber() * 100),
      delivery_threshold_pct: c.deliveryThresholdPct,
      unverified_reach_cap: c.unverifiedReachCap,
      proof_validity_days: c.proofValidityDays,
      min_trust_score: c.minTrustScore,
      offer_expiry_hours: c.offerExpiryHours,
      withdrawal_minimum_minor: Number(c.withdrawalMinimumMinor),
    };
  }

  async updateRateConfig(adminId: string, dto: RateConfigUpdateDto) {
    const c = await this.rateConfig.getActive();
    const data: Prisma.RateConfigUpdateInput = {};
    if (dto.rpm_minor !== undefined) data.rpmMinor = dto.rpm_minor;
    if (dto.take_rate_pct !== undefined) data.takeRate = new Prisma.Decimal(dto.take_rate_pct / 100);
    if (dto.delivery_threshold_pct !== undefined) data.deliveryThresholdPct = dto.delivery_threshold_pct;
    if (dto.unverified_reach_cap !== undefined) data.unverifiedReachCap = dto.unverified_reach_cap;
    if (dto.proof_validity_days !== undefined) data.proofValidityDays = dto.proof_validity_days;
    if (dto.min_trust_score !== undefined) data.minTrustScore = dto.min_trust_score;
    if (dto.offer_expiry_hours !== undefined) data.offerExpiryHours = dto.offer_expiry_hours;
    if (dto.withdrawal_minimum_minor !== undefined) data.withdrawalMinimumMinor = BigInt(dto.withdrawal_minimum_minor);

    await this.prisma.$transaction(async (tx) => {
      await tx.rateConfig.update({ where: { id: c.id }, data });
      await this.audit.record(
        { actorId: adminId, action: 'rate_config.update', entityType: 'rate_config', entityId: c.id, after: dto },
        tx,
      );
    });
    return this.platformRules();
  }

  async auditLog(limit = 50) {
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      include: { actor: { select: { email: true } } },
    });
    return rows.map((a) => ({
      id: a.id,
      actor: a.actor?.email ?? 'system',
      action: a.action,
      entity_type: a.entityType,
      entity_id: a.entityId,
      reason: a.reason,
      created_at: a.createdAt.toISOString(),
    }));
  }

  async team() {
    const admins = await this.prisma.user.findMany({
      where: { roles: { some: { role: Role.ADMIN } } },
      include: { roles: { where: { role: Role.ADMIN }, select: { capabilities: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return admins.map((u) => ({
      id: u.id,
      email: u.email,
      status: u.status,
      capabilities: [...new Set(u.roles.flatMap((r) => r.capabilities))],
    }));
  }

  // ── Analytics: platform overview ─────────────────────────

  async analytics() {
    const [gmv, liveCampaigns, activePromoters, activeClients, promotersByStatus, campaignsByStatus, config] = await Promise.all([
      this.prisma.campaign.aggregate({ where: { status: { in: FUNDED_STATUSES }, priceMinor: { not: null } }, _sum: { priceMinor: true } }),
      this.prisma.campaign.count({ where: { status: { in: [CampaignStatus.LIVE, CampaignStatus.PAUSED] } } }),
      this.prisma.promoterProfile.count({ where: { status: PromoterStatus.ACTIVE } }),
      this.prisma.clientOrg.count({ where: { status: ClientOrgStatus.ACTIVE } }),
      this.prisma.promoterProfile.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.campaign.groupBy({ by: ['status'], _count: { _all: true } }),
      this.rateConfig.getActive(),
    ]);

    // Ralia revenue is the balance of the platform revenue account.
    const revenueAcc = await this.prisma.account.findFirst({ where: { kind: AccountKind.RALIA_REVENUE, ownerId: null } });
    let revenue = 0n;
    if (revenueAcc) {
      const g = await this.prisma.ledgerEntry.groupBy({ by: ['direction'], where: { accountId: revenueAcc.id }, _sum: { amountMinor: true } });
      let cr = 0n;
      let dr = 0n;
      for (const x of g) {
        if (x.direction === EntryDirection.CREDIT) cr = x._sum.amountMinor ?? 0n;
        else dr = x._sum.amountMinor ?? 0n;
      }
      revenue = cr - dr;
    }

    return {
      gmv: toMoney(gmv._sum.priceMinor ?? 0n),
      revenue: toMoney(revenue),
      take_rate_pct: Math.round(config.takeRate.toNumber() * 100),
      live_campaigns: liveCampaigns,
      active_promoters: activePromoters,
      active_clients: activeClients,
      promoters_by_status: promotersByStatus.map((r) => ({ status: r.status, count: r._count._all })),
      campaigns_by_status: campaignsByStatus.map((r) => ({ status: r.status, count: r._count._all })),
    };
  }
}

/** Campaign states whose quoted price counts as client spend / GMV. */
const FUNDED_STATUSES: CampaignStatus[] = [
  CampaignStatus.LIVE,
  CampaignStatus.PAUSED,
  CampaignStatus.ENDED,
  CampaignStatus.FULFILLED,
  CampaignStatus.SETTLED,
];
