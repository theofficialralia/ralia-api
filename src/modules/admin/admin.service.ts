import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  AccountKind,
  AssignmentStatus,
  CampaignStatus,
  ChannelStatus,
  ClientOrgStatus,
  DeliverySlotStatus,
  EntryDirection,
  KycStatus,
  Prisma,
  PromoterStatus,
  ReconciliationStatus,
  Role,
  SlotStatus,
  VerificationTier,
  Verdict,
  WithdrawalStatus,
} from '@prisma/client';
import { computeAssignmentRollup } from '../../common/delivery/delivery';
import { settleDelivery } from '../../common/pricing/pricing';
import { asRoleConfig, describeRoleTask } from '../../common/campaign/role-task';
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

  /** Set a promoter's KYC state (§10) after reviewing their ID evidence. Gates cash-out. */
  async setKyc(adminId: string, userId: string, status: KycStatus): Promise<AdminDecisionDto> {
    const profile = await this.prisma.promoterProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('No promoter profile for that user.');

    const now = new Date();
    const verified = status === KycStatus.VERIFIED;
    await this.prisma.$transaction(async (tx) => {
      await tx.promoterProfile.update({
        where: { userId },
        data: {
          kycStatus: status,
          kycVerifiedAt: verified ? now : null,
          kycVerifiedBy: verified ? adminId : null,
        },
      });
      await this.audit.record(
        {
          actorId: adminId,
          action: 'promoter.kyc',
          entityType: 'promoter_profile',
          entityId: userId,
          before: { kycStatus: profile.kycStatus },
          after: { kycStatus: status },
        },
        tx,
      );
    });

    return { id: userId, status: profile.status, message: `KYC set to ${status}.` };
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

  async rejectCampaign(adminId: string, campaignId: string, reason: string, terminal = false): Promise<AdminDecisionDto> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new NotFoundException('No such campaign.');
    if (campaign.status !== CampaignStatus.PENDING_APPROVAL) {
      throw new ConflictException(`A ${campaign.status} campaign is not awaiting approval.`);
    }

    // Two-type reject: "temporary" (default) → REJECTED, the owner can edit and
    // resubmit; "entirely"/terminal → CANCELLED, not resubmittable.
    const nextStatus = terminal ? CampaignStatus.CANCELLED : CampaignStatus.REJECTED;
    const ownerId = await this.campaignOwnerId(campaign.clientOrgId);
    await this.prisma.$transaction(async (tx) => {
      await tx.campaign.update({ where: { id: campaignId }, data: { status: nextStatus, rejectReason: reason } });
      if (ownerId) {
        await this.notifications.create(
          {
            userId: ownerId,
            type: 'campaign.rejected',
            title: terminal ? 'Campaign rejected' : 'Campaign needs changes',
            body: terminal
              ? `"${campaign.name}" was rejected and can't be resubmitted: ${reason}`
              : `"${campaign.name}" wasn't approved: ${reason} Edit and resubmit it for review.`,
            data: { campaignId, reason, terminal },
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
   * (ALGORITHMS.md §2). The delivered fee and Ralia's take move in ONE balanced
   * transaction, so escrow settles to exactly what it held for the slot and a
   * retry can't strand any leg. There is no client refund — an under-delivery is
   * retained by the platform, not returned (there is no client wallet).
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
      include: { assignment: { include: { campaign: true, deliverySlots: true } }, deliverySlot: true },
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

    // §multi-day: settle against THIS post's per-slot economics. Legacy submissions
    // with no slot fall back to the assignment-level figures (pre-slot rows).
    const slot = submission.deliverySlot;
    const grossBasis = slot ? slot.grossMinor : assignment.grossMinor;
    const reachBasis = slot ? slot.promisedReach : assignment.promisedReach;
    const dueBasis = slot ? slot.dueAt : assignment.dueAt;
    if (reachBasis <= 0) {
      throw new BadRequestException('This post has no promised reach recorded, so it cannot be settled pro-rata.');
    }

    // The client only ever hears about verified, admin-approved work — so the owner
    // is resolved here and notified from inside the approval, never from a promoter action.
    const ownerId = await this.campaignOwnerId(campaign.clientOrgId);
    const config = await this.rateConfig.getSettlementConfig();
    const settlement = settleDelivery(grossBasis, verifiedViews, reachBasis, config);

    // The §2 delivery floor: below the threshold, approval is refused so the
    // promoter can resubmit rather than be part-paid for an under-delivery.
    if (!settlement.meetsThreshold) {
      throw new BadRequestException(
        `Verified ${verifiedViews} views is below the ${config.deliveryThresholdPct}% threshold of the promised ${reachBasis}. Reject this submission so the promoter can resubmit.`,
      );
    }

    const promoterAccountId = await this.ledger.getOrCreateAccount(
      AccountKind.PROMOTER_AVAILABLE,
      assignment.promoterId,
    );

    // The delivered fee and Ralia's take (which retains any undelivered remainder)
    // move out of escrow together — no client refund.
    const { replayed } = await this.ledger.settleSubmission({
      submissionId,
      escrowAccountId: campaign.escrowAccountId,
      promoterAccountId,
      feeMinor: settlement.promoterFeeMinor,
      takeMinor: settlement.raliaTakeMinor,
      idempotencyKey,
      actorId: adminId,
    });

    if (!replayed) {
      const now = new Date();
      // On-time = the approved post landed by ITS deadline. No deadline → on-time
      // (nothing to be late against). Drives the trust delta (§4) + reliability (§5).
      const deliveredOnTime = dueBasis === null || submission.submittedAt <= dueBasis;
      // Roll the assignment status up from all its posts, with this one now APPROVED.
      const nextSlotViews = assignment.deliverySlots.length
        ? assignment.deliverySlots.map((s) => ({ index: s.index, status: s.id === slot?.id ? DeliverySlotStatus.APPROVED : s.status }))
        : [{ index: 1, status: DeliverySlotStatus.APPROVED }];
      const rollup = computeAssignmentRollup(nextSlotViews);
      await this.prisma.$transaction(async (tx) => {
        await tx.submission.update({
          where: { id: submissionId },
          data: { verdict: Verdict.APPROVED, verifiedReach: verifiedViews, reviewedBy: adminId, reviewedAt: now },
        });
        if (slot) {
          await tx.deliverySlot.update({ where: { id: slot.id }, data: { status: DeliverySlotStatus.APPROVED } });
        }
        // paidAt/deliveredOnTime are stamped once, when the assignment first reaches
        // a paid state (all posts resolved with at least one approved).
        const becomesPaid = rollup.status === AssignmentStatus.PAID && assignment.paidAt === null;
        await tx.assignment.update({
          where: { id: assignment.id },
          data: {
            status: rollup.status,
            ...(becomesPaid ? { paidAt: now, deliveredOnTime } : {}),
          },
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

        // Client-facing, and only ever from this admin-verified point: the client
        // learns a delivery landed once we've confirmed its quality — never straight
        // from a promoter's submission. Keeps the client's view to approved work only.
        if (ownerId) {
          await this.notifications.create(
            {
              userId: ownerId,
              type: 'campaign.evidence_verified',
              title: 'New verified delivery',
              body: `A promoter's post on "${campaign.name}" passed review with ${verifiedViews.toLocaleString('en-NG')} verified views. See it in your evidence gallery.`,
              data: { campaignId: campaign.id, submissionId, verifiedViews },
              dedupeKey: `campaign.evidence_verified:${submissionId}`,
            },
            tx,
          );
        }

        // Fulfilment is decided here, at the approval that resolves the last post:
        // when no campaign slot is still open AND no scheduled post is still pending
        // or in review, every promised post has landed and passed review → FULFILLED.
        // (§multi-day: this is now per-post, not per-assignment.)
        if (campaign.status === CampaignStatus.LIVE) {
          const openSlots = await tx.campaignSlot.count({
            where: { campaignId: campaign.id, status: { in: [SlotStatus.OPEN, SlotStatus.OFFERED] } },
          });
          const outstandingPosts = await tx.deliverySlot.count({
            where: {
              assignment: { campaignId: campaign.id },
              status: { in: [DeliverySlotStatus.PENDING, DeliverySlotStatus.SUBMITTED] },
            },
          });
          if (openSlots === 0 && outstandingPosts === 0) {
            await tx.campaign.update({ where: { id: campaign.id }, data: { status: CampaignStatus.FULFILLED } });
            if (ownerId) {
              await this.notifications.create(
                {
                  userId: ownerId,
                  type: 'campaign.fulfilled',
                  title: 'Campaign fulfilled 🎉',
                  body: `"${campaign.name}" is complete — every slot delivered and passed review. Open it to see the full evidence gallery and export your report.`,
                  data: { campaignId: campaign.id },
                  dedupeKey: `campaign.fulfilled:${campaign.id}`,
                },
                tx,
              );
            }
          }
        }
        await this.audit.record(
          {
            actorId: adminId,
            action: 'submission.approve',
            entityType: 'submission',
            entityId: submissionId,
            before: { verdict: Verdict.PENDING, assignmentStatus: assignment.status },
            after: {
              verdict: Verdict.APPROVED,
              assignmentStatus: rollup.status,
              deliverySlotId: slot?.id ?? null,
              verifiedReach: verifiedViews,
              promisedReach: reachBasis,
              feeMinor: settlement.promoterFeeMinor,
              takeMinor: settlement.raliaTakeMinor,
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
      include: { assignment: { include: { deliverySlots: true } }, deliverySlot: true },
    });
    if (!submission) throw new NotFoundException('No such submission.');
    if (submission.verdict !== Verdict.PENDING) {
      throw new ConflictException(`This submission is already ${submission.verdict.toLowerCase()}.`);
    }

    const slot = submission.deliverySlot;
    // §multi-day: reopen just THIS post for resubmission; the assignment status is
    // the roll-up of all its posts. Legacy submissions with no slot fall back to the
    // pre-slot behaviour — the whole assignment goes REJECTED (resubmittable).
    const hasSlots = submission.assignment.deliverySlots.length > 0;
    const nextAssignmentStatus = hasSlots
      ? computeAssignmentRollup(
          submission.assignment.deliverySlots.map((s) => ({ index: s.index, status: s.id === slot?.id ? DeliverySlotStatus.REJECTED : s.status })),
        ).status
      : AssignmentStatus.REJECTED;

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.submission.update({
        where: { id: submissionId },
        data: { verdict: Verdict.REJECTED, reviewedBy: adminId, reviewedAt: now, rejectReason: reason },
      });
      if (slot) {
        await tx.deliverySlot.update({ where: { id: slot.id }, data: { status: DeliverySlotStatus.REJECTED } });
      }
      // Back to a submittable state so the promoter can submit again — a rejection
      // is feedback, not the end of the post.
      await tx.assignment.update({
        where: { id: submission.assignmentId },
        data: { status: nextAssignmentStatus },
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

    // §10 KYC gate: real money never leaves to an unverified identity.
    const profile = await this.prisma.promoterProfile.findUnique({ where: { userId: withdrawal.promoterId } });
    if (profile?.kycStatus !== KycStatus.VERIFIED) {
      throw new BadRequestException('This promoter is not KYC-verified — verify their identity before approving a payout.');
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

  /**
   * Fail a withdrawal that never reached PAID (bad bank details, admin declines).
   * REQUESTED/APPROVED → FAILED with a reason. No ledger posting existed yet, so this
   * simply releases the implicit reservation — the funds were never debited.
   */
  async failWithdrawal(adminId: string, withdrawalId: string, reason: string): Promise<AdminDecisionDto> {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) throw new NotFoundException('No such withdrawal.');
    if (withdrawal.status !== WithdrawalStatus.REQUESTED && withdrawal.status !== WithdrawalStatus.APPROVED) {
      throw new ConflictException(`Only a requested or approved withdrawal can be failed (this one is ${withdrawal.status.toLowerCase()}). A paid one must be reversed.`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.withdrawal.update({ where: { id: withdrawalId }, data: { status: WithdrawalStatus.FAILED, failureReason: reason } });
      await this.notifications.create(
        {
          userId: withdrawal.promoterId,
          type: 'withdrawal.failed',
          title: 'Withdrawal couldn’t be sent',
          body: `Your withdrawal of ${formatNaira(withdrawal.amountMinor)} couldn’t be processed: ${reason} Your balance is unchanged — you can request it again.`,
          data: { withdrawalId, reason },
          dedupeKey: `withdrawal.failed:${withdrawalId}`,
        },
        tx,
      );
      await this.audit.record(
        {
          actorId: adminId,
          action: 'withdrawal.fail',
          entityType: 'withdrawal',
          entityId: withdrawalId,
          before: { status: withdrawal.status },
          after: { status: WithdrawalStatus.FAILED, reason },
        },
        tx,
      );
    });

    return { id: withdrawalId, status: WithdrawalStatus.FAILED, message: 'Withdrawal failed; the promoter’s balance is intact.' };
  }

  /**
   * Reverse a PAID withdrawal whose transfer bounced: reverse the ledger posting so
   * the money returns to the promoter's available balance, then mark it REVERSED.
   * Idempotent via the key, like recordWithdrawalPaid.
   */
  async reverseWithdrawal(adminId: string, withdrawalId: string, reason: string, idempotencyKey: string): Promise<AdminDecisionDto> {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) throw new NotFoundException('No such withdrawal.');

    if (await this.ledger.alreadyPosted(idempotencyKey)) {
      return { id: withdrawalId, status: withdrawal.status, message: 'Already recorded.' };
    }
    if (withdrawal.status !== WithdrawalStatus.PAID) {
      throw new ConflictException(`Only a paid withdrawal can be reversed (this one is ${withdrawal.status.toLowerCase()}).`);
    }

    const promoterAccountId = await this.ledger.getOrCreateAccount(AccountKind.PROMOTER_AVAILABLE, withdrawal.promoterId);
    const { replayed } = await this.ledger.reverseWithdrawal({
      withdrawalId,
      promoterAccountId,
      amountMinor: withdrawal.amountMinor,
      idempotencyKey,
      actorId: adminId,
    });

    if (!replayed) {
      await this.prisma.$transaction(async (tx) => {
        await tx.withdrawal.update({ where: { id: withdrawalId }, data: { status: WithdrawalStatus.REVERSED, failureReason: reason } });
        await this.notifications.create(
          {
            userId: withdrawal.promoterId,
            type: 'withdrawal.reversed',
            title: 'Withdrawal returned to your balance',
            body: `Your ${formatNaira(withdrawal.amountMinor)} transfer didn’t go through: ${reason} We’ve added it back to your balance — you can withdraw again.`,
            data: { withdrawalId, reason },
            dedupeKey: `withdrawal.reversed:${withdrawalId}`,
          },
          tx,
        );
        await this.audit.record(
          {
            actorId: adminId,
            action: 'withdrawal.reverse',
            entityType: 'withdrawal',
            entityId: withdrawalId,
            before: { status: WithdrawalStatus.PAID },
            after: { status: WithdrawalStatus.REVERSED, reason, amountMinor: withdrawal.amountMinor },
          },
          tx,
        );
      });
    }

    return { id: withdrawalId, status: WithdrawalStatus.REVERSED, message: replayed ? 'Already recorded.' : 'Withdrawal reversed; funds returned to the promoter.' };
  }

  /**
   * Platform exposure (§10): the money position by account kind, plus the payout
   * obligation about to leave. promoter_payable is what Ralia owes promoters — every
   * kobo of it was moved from funded escrow at settlement, so it is fully backed by
   * construction. This report surfaces that so an operator can see obligations never
   * exceed settled funds.
   */
  async exposureReport() {
    const accounts = await this.prisma.account.findMany({ select: { id: true, kind: true } });
    const kindById = new Map(accounts.map((a) => [a.id, a.kind]));
    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['accountId', 'direction'],
      _sum: { amountMinor: true },
    });

    const debit: Partial<Record<AccountKind, bigint>> = {};
    const credit: Partial<Record<AccountKind, bigint>> = {};
    for (const g of grouped) {
      const kind = kindById.get(g.accountId);
      if (!kind) continue;
      const amt = g._sum.amountMinor ?? 0n;
      if (g.direction === EntryDirection.DEBIT) debit[kind] = (debit[kind] ?? 0n) + amt;
      else credit[kind] = (credit[kind] ?? 0n) + amt;
    }
    // BANK_CLEARING is debit-normal (cash in/out); every other kind is credit-normal.
    const bal = (kind: AccountKind): bigint =>
      kind === AccountKind.BANK_CLEARING
        ? (debit[kind] ?? 0n) - (credit[kind] ?? 0n)
        : (credit[kind] ?? 0n) - (debit[kind] ?? 0n);

    const inFlight = await this.prisma.withdrawal.aggregate({
      where: { status: { in: [WithdrawalStatus.REQUESTED, WithdrawalStatus.APPROVED] } },
      _sum: { amountMinor: true },
    });

    const promoterPayable = bal(AccountKind.PROMOTER_AVAILABLE);
    return {
      promoter_payable: toMoney(promoterPayable),
      in_flight_withdrawals: toMoney(inFlight._sum.amountMinor ?? 0n),
      escrow_held: toMoney(bal(AccountKind.CAMPAIGN_ESCROW)),
      client_wallet: toMoney(bal(AccountKind.CLIENT_WALLET)),
      platform_revenue: toMoney(bal(AccountKind.RALIA_REVENUE)),
      bank_clearing_net: toMoney(bal(AccountKind.BANK_CLEARING)),
      // Promoter money is fully settled cash — never an unfunded promise.
      fully_backed: promoterPayable >= 0n,
    };
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
    return Promise.all(rows.map(async (p) => ({
      user_id: p.userId,
      full_name: p.fullName,
      location_state: p.locationState,
      trust_score: p.trustScore.toNumber(),
      roles: p.roles,
      // A live preview of the §3 capability the admin is confirming — approval freezes it.
      capability_preview: await this.scoring.computeCapability(p.userId, {}, this.prisma),
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
    })));
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
    // Total human clicks delivered across the campaign's assignments.
    const totalClicks = await this.prisma.clickEvent.count({
      where: { isBot: false, trackingLink: { assignment: { campaignId } } },
    });
    // Expected reach = total promised by accepted promoters; confirmed = admin-verified
    // reach across approved submissions. Powers the Submissions-tab stat cards.
    const [expectedAgg, confirmedAgg] = await Promise.all([
      this.prisma.assignment.aggregate({ where: { campaignId }, _sum: { promisedReach: true } }),
      this.prisma.submission.aggregate({ where: { assignment: { campaignId }, verdict: Verdict.APPROVED }, _sum: { verifiedReach: true } }),
    ]);
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      expected_reach: expectedAgg._sum.promisedReach ?? 0,
      confirmed_reach: confirmedAgg._sum.verifiedReach ?? 0,
      objective: c.objective,
      total_clicks: totalClicks,
      description: c.description,
      promoter_instructions: c.promoterInstructions,
      role_config: asRoleConfig(c.roleConfig),
      task: describeRoleTask(c.targeting?.roles?.[0] ?? 'DISTRIBUTOR', asRoleConfig(c.roleConfig)),
      destination_url: c.destinationUrl,
      needs_creative: c.needsCreative,
      slots_total: c.slotsTotal,
      slots_filled: c.slotsFilled,
      price: c.priceMinor === null ? null : toMoney(c.priceMinor),
      budget: toMoney(c.budgetMinor),
      quoted_at: c.quotedAt?.toISOString() ?? null,
      starts_at: c.startsAt?.toISOString() ?? null,
      ends_at: c.endsAt?.toISOString() ?? null,
      cadence: c.cadence,
      posts_required: c.postsRequired,
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
        artifacts: { select: { id: true, reuseOfId: true, file: { select: { id: true } } } },
        deliverySlot: { select: { index: true, feeMinor: true, promisedReach: true } },
        assignment: {
          select: {
            id: true,
            campaignId: true,
            promoterId: true,
            feeMinor: true,
            promisedReach: true,
            campaign: { select: { name: true, objective: true } },
            promoter: { select: { promoterProfile: { select: { fullName: true } } } },
            _count: { select: { deliverySlots: true } },
          },
        },
      },
      orderBy: { submittedAt: 'asc' },
    });
    return Promise.all(
      rows.map(async (s) => {
        const primary = s.artifacts[0];
        // §multi-day: review + settle against THIS post's per-slot economics.
        const postsTotal = s.assignment._count.deliverySlots;
        return {
          id: s.id,
          assignment_id: s.assignmentId,
          campaign_id: s.assignment.campaignId,
          campaign_name: s.assignment.campaign.name,
          objective: s.assignment.campaign.objective,
          promoter_id: s.assignment.promoterId,
          promoter_name: s.assignment.promoter.promoterProfile?.fullName ?? null,
          // Per-post figures when the submission answers a scheduled post; fall back
          // to the assignment totals for legacy (pre-slot) rows.
          fee: toMoney(s.deliverySlot ? s.deliverySlot.feeMinor : s.assignment.feeMinor),
          promised_reach: s.deliverySlot ? s.deliverySlot.promisedReach : s.assignment.promisedReach,
          day_index: s.deliverySlot?.index ?? null,
          posts_total: postsTotal,
          claimed_views: s.claimedViews,
          // Real human clicks driven — a delivery signal the admin weighs against the
          // self-reported view count when verifying.
          clicks: await this.prisma.clickEvent.count({
            where: { isBot: false, trackingLink: { assignmentId: s.assignmentId } },
          }),
          auto_flag: s.autoFlag,
          public_url: s.publicUrl,
          note: s.note,
          // Provider-agnostic file route so the admin can open the actual screenshot
          // to verify the count (streams for local, redirects to the CDN otherwise).
          image_url: primary?.file ? `/v1/files/${primary.file.id}` : null,
          submitted_at: s.submittedAt.toISOString(),
          // reuse_of_id tells the admin this screenshot perceptually matched an earlier one.
          artifacts: s.artifacts.map((a) => ({ id: a.id, reuse_of_id: a.reuseOfId })),
        };
      }),
    );
  }

  /**
   * Every submission for one campaign — the full proof history, not just what's
   * awaiting review. Powers the campaign workspace's Submissions tab, so an approved
   * or rejected post stays visible (with its verdict) after it leaves the queue.
   */
  async campaignSubmissions(campaignId: string) {
    const rows = await this.prisma.submission.findMany({
      where: { assignment: { campaignId } },
      include: {
        artifacts: { select: { id: true, reuseOfId: true, file: { select: { id: true } } } },
        deliverySlot: { select: { index: true, feeMinor: true, promisedReach: true } },
        assignment: {
          select: {
            id: true,
            campaignId: true,
            promoterId: true,
            feeMinor: true,
            promisedReach: true,
            campaign: { select: { name: true, objective: true } },
            promoter: { select: { promoterProfile: { select: { fullName: true } } } },
            _count: { select: { deliverySlots: true } },
          },
        },
      },
      orderBy: { submittedAt: 'desc' },
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
          fee: toMoney(s.deliverySlot ? s.deliverySlot.feeMinor : s.assignment.feeMinor),
          promised_reach: s.deliverySlot ? s.deliverySlot.promisedReach : s.assignment.promisedReach,
          day_index: s.deliverySlot?.index ?? null,
          posts_total: s.assignment._count.deliverySlots,
          claimed_views: s.claimedViews,
          // The admin-verified figure, present once a submission has been decided.
          verified_reach: s.verifiedReach,
          verdict: s.verdict,
          reject_reason: s.rejectReason,
          reviewed_at: s.reviewedAt?.toISOString() ?? null,
          clicks: await this.prisma.clickEvent.count({
            where: { isBot: false, trackingLink: { assignmentId: s.assignmentId } },
          }),
          auto_flag: s.autoFlag,
          public_url: s.publicUrl,
          note: s.note,
          image_url: primary?.file ? `/v1/files/${primary.file.id}` : null,
          submitted_at: s.submittedAt.toISOString(),
          artifacts: s.artifacts.map((a) => ({ id: a.id, reuse_of_id: a.reuseOfId })),
        };
      }),
    );
  }

  async pendingWithdrawals() {
    const rows = await this.prisma.withdrawal.findMany({
      where: { status: { in: [WithdrawalStatus.REQUESTED, WithdrawalStatus.APPROVED] } },
      include: {
        promoter: { select: { promoterProfile: { select: { fullName: true, kycStatus: true } } } },
        bankAccount: { select: { accountName: true, accountNumberLast4: true, bankCode: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((w) => ({
      id: w.id,
      promoter_id: w.promoterId,
      promoter_name: w.promoter.promoterProfile?.fullName ?? null,
      // Surfaced so the admin sees the §10 gate before approving — an unverified
      // promoter's payout will be refused.
      kyc_status: w.promoter.promoterProfile?.kycStatus ?? 'NONE',
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
      rpm_distribution_minor: c.rpmDistributionMinor,
      rpm_creation_minor: c.rpmCreationMinor,
      floor_distribution_minor: Number(c.floorDistributionMinor),
      floor_creation_minor: Number(c.floorCreationMinor),
      default_reach_distribution: c.defaultReachDistribution,
      default_reach_creation: c.defaultReachCreation,
      default_promoters_distribution: c.defaultPromotersDistribution,
      default_promoters_creation: c.defaultPromotersCreation,
      take_rate_pct: Math.round(c.takeRate.toNumber() * 100),
      delivery_threshold_pct: c.deliveryThresholdPct,
      unverified_reach_cap: c.unverifiedReachCap,
      proof_validity_days: c.proofValidityDays,
      min_trust_score: c.minTrustScore,
      offer_expiry_hours: c.offerExpiryHours,
      delivery_window_hours: c.deliveryWindowHours,
      contingency_buffer_hours: c.contingencyBufferHours,
      withdrawal_minimum_minor: Number(c.withdrawalMinimumMinor),
    };
  }

  async updateRateConfig(adminId: string, dto: RateConfigUpdateDto) {
    const c = await this.rateConfig.getActive();
    const data: Prisma.RateConfigUpdateInput = {};
    if (dto.rpm_minor !== undefined) data.rpmMinor = dto.rpm_minor;
    if (dto.rpm_distribution_minor !== undefined) data.rpmDistributionMinor = dto.rpm_distribution_minor;
    if (dto.rpm_creation_minor !== undefined) data.rpmCreationMinor = dto.rpm_creation_minor;
    if (dto.floor_distribution_minor !== undefined) data.floorDistributionMinor = BigInt(dto.floor_distribution_minor);
    if (dto.floor_creation_minor !== undefined) data.floorCreationMinor = BigInt(dto.floor_creation_minor);
    if (dto.default_reach_distribution !== undefined) data.defaultReachDistribution = dto.default_reach_distribution;
    if (dto.default_reach_creation !== undefined) data.defaultReachCreation = dto.default_reach_creation;
    if (dto.default_promoters_distribution !== undefined) data.defaultPromotersDistribution = dto.default_promoters_distribution;
    if (dto.default_promoters_creation !== undefined) data.defaultPromotersCreation = dto.default_promoters_creation;
    if (dto.take_rate_pct !== undefined) data.takeRate = new Prisma.Decimal(dto.take_rate_pct / 100);
    if (dto.delivery_threshold_pct !== undefined) data.deliveryThresholdPct = dto.delivery_threshold_pct;
    if (dto.unverified_reach_cap !== undefined) data.unverifiedReachCap = dto.unverified_reach_cap;
    if (dto.proof_validity_days !== undefined) data.proofValidityDays = dto.proof_validity_days;
    if (dto.min_trust_score !== undefined) data.minTrustScore = dto.min_trust_score;
    if (dto.offer_expiry_hours !== undefined) data.offerExpiryHours = dto.offer_expiry_hours;
    if (dto.delivery_window_hours !== undefined) data.deliveryWindowHours = dto.delivery_window_hours;
    if (dto.contingency_buffer_hours !== undefined) data.contingencyBufferHours = dto.contingency_buffer_hours;
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
