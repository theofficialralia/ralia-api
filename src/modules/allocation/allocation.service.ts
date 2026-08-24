import { Injectable, Logger } from '@nestjs/common';
import { AssignmentStatus, CampaignStatus, DeliverySlotStatus, OfferStatus, SlotStatus } from '@prisma/client';
import { computeAssignmentRollup, hasConsecutiveMisses } from '../../common/delivery/delivery';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateConfigService } from '../../common/rate-config/rate-config.service';
import { DEFAULT_SCORING_CONFIG, overOfferCount } from '../../common/scoring/scoring';
import { MatchingService } from '../matching/matching.service';
import { NotificationService } from '../notifications/notification.service';
import { ScoringService } from '../scoring/scoring.service';

/** Delivery-slot states a promoter can still act on — the ones a missed deadline forfeits. */
const RECLAIMABLE_SLOT: DeliverySlotStatus[] = [DeliverySlotStatus.PENDING, DeliverySlotStatus.REJECTED];
/** Two missed posts back-to-back triggers re-allocation of the remainder (§multi-day). */
const CONSECUTIVE_MISS_THRESHOLD = 2;

export type AllocationPhase = 'inactive' | 'full' | 'head-start' | 'open';

export type AllocationResult = {
  phase: AllocationPhase;
  openSlots: number;
  outstandingOffers: number;
  sent: number;
};

/**
 * The timer-driven allocation spine (ALGORITHMS.md §8). Two idempotent sweeps the
 * scheduler runs on an interval:
 *
 *   - expireStaleOffers — close SENT offers whose accept window has lapsed
 *   - reclaimOverdueAssignments — return a blown-deadline slot to the pool and ding
 *     the no-show promoter
 *
 * Both are safe to run repeatedly and concurrently: state transitions are guarded so
 * a slot is never released twice and a no-show is never dinged twice.
 */
@Injectable()
export class AllocationService {
  private readonly logger = new Logger(AllocationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scoring: ScoringService,
    private readonly matching: MatchingService,
    private readonly rateConfig: RateConfigService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * One hybrid allocation pass for a LIVE campaign (ALGORITHMS.md §8). Fills open
   * slots by extending offers to the best-fit candidates the matching engine returns
   * (already hard-filtered, ranked and newbie-gated), in two phases anchored on when
   * the campaign went live:
   *
   *   - head-start — inside `headStartHours` of approval: an exclusive shot for the
   *     top fits, one offer per open slot, no over-offer.
   *   - open — after the window: free-to-air, over-offered to ~1.5× open slots so
   *     declines and no-shows still fill fast.
   *
   * Over-offering never oversells: accept() reserves slots with FOR UPDATE SKIP
   * LOCKED, so surplus offers simply find the campaign full. Idempotent to re-run —
   * it only tops outstanding live offers up to the phase target, and matching skips
   * anyone already engaged.
   */
  async allocateCampaign(campaignId: string, now: Date): Promise<AllocationResult> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) return { phase: 'inactive', openSlots: 0, outstandingOffers: 0, sent: 0 };
    if (campaign.status !== CampaignStatus.LIVE) {
      return { phase: 'inactive', openSlots: 0, outstandingOffers: 0, sent: 0 };
    }

    const openSlots = Math.max(campaign.slotsTotal - campaign.slotsFilled, 0);
    const outstandingOffers = await this.prisma.offer.count({
      where: { campaignId, status: OfferStatus.SENT, expiresAt: { gt: now } },
    });
    if (openSlots === 0) return { phase: 'full', openSlots: 0, outstandingOffers, sent: 0 };

    const rate = await this.rateConfig.getActive();
    const liveUntil = campaign.approvedAt
      ? new Date(campaign.approvedAt.getTime() + rate.headStartHours * 60 * 60 * 1000)
      : null;
    const inHeadStart = liveUntil !== null && now < liveUntil;
    const phase: AllocationPhase = inHeadStart ? 'head-start' : 'open';

    // Head-start reserves an exclusive 1× shot for the top fits; open over-offers.
    const target = inHeadStart ? openSlots : overOfferCount(openSlots, DEFAULT_SCORING_CONFIG);
    const toSend = Math.max(target - outstandingOffers, 0);
    if (toSend === 0) return { phase, openSlots, outstandingOffers, sent: 0 };

    // candidates() is already ranked, hard-filtered and newbie-gated, and excludes
    // anyone holding a live/accepted offer — so we just take the top slice.
    const ranked = await this.matching.candidates(campaignId);
    const pick = ranked.slice(0, toSend).map((c) => c.promoter_id);
    if (pick.length === 0) return { phase, openSlots, outstandingOffers, sent: 0 };

    const created = await this.matching.sendOffers(campaignId, pick);
    if (created.length > 0) this.logger.log(`Allocated ${created.length} offer(s) to campaign ${campaignId} (${phase}).`);
    return { phase, openSlots, outstandingOffers, sent: created.length };
  }

  /**
   * Run an allocation pass over every LIVE campaign — the unattended entry point the
   * scheduler calls. One campaign's failure is logged and skipped, never aborting the
   * rest of the sweep.
   */
  async allocateAll(now: Date): Promise<{ campaigns: number; offersSent: number }> {
    const live = await this.prisma.campaign.findMany({
      where: { status: CampaignStatus.LIVE },
      select: { id: true },
    });
    let offersSent = 0;
    for (const c of live) {
      try {
        const { sent } = await this.allocateCampaign(c.id, now);
        offersSent += sent;
      } catch (err) {
        this.logger.error(`Allocation failed for campaign ${c.id}`, err instanceof Error ? err.stack : String(err));
      }
    }
    return { campaigns: live.length, offersSent };
  }

  /**
   * Mark every SENT offer past its expiry as EXPIRED. Offers reserve no slot (the
   * slot is taken at accept), so this is pure housekeeping — it just stops a lapsed
   * offer being accepted and keeps the promoter's offer list honest.
   */
  async expireStaleOffers(now: Date): Promise<number> {
    const { count } = await this.prisma.offer.updateMany({
      where: { status: OfferStatus.SENT, expiresAt: { lt: now } },
      data: { status: OfferStatus.EXPIRED },
    });
    if (count > 0) this.logger.log(`Expired ${count} stale offer(s).`);
    return count;
  }

  /**
   * §multi-day reclaim, working per scheduled post rather than per assignment.
   *
   * A post whose internal deadline lapsed without acceptable proof is marked MISSED
   * and forfeits its own pro-rata pay — the rest of the assignment continues. But
   * two MISSED posts back-to-back mean the promoter is failing and the reach
   * projection is at risk, so the assignment's REMAINING posts are pulled and the
   * campaign slot is re-opened (carrying only the outstanding post count) for a
   * replacement to cover over the remaining window.
   *
   * SUBMITTED posts are spared (the promoter delivered, awaiting review). Each write
   * is guarded by a status-conditional updateMany so overlapping sweeps can't
   * double-forfeit a post or double-ding a promoter.
   */
  async reclaimOverdueAssignments(now: Date): Promise<number> {
    const overdue = await this.prisma.deliverySlot.findMany({
      where: {
        status: { in: RECLAIMABLE_SLOT },
        dueAt: { lt: now },
        assignment: { status: { notIn: [AssignmentStatus.CANCELLED, AssignmentStatus.PAID] } },
      },
      select: { id: true, index: true, assignmentId: true, assignment: { select: { promoterId: true, campaignId: true } } },
    });

    let missed = 0;
    // Newly-missed posts per assignment THIS sweep — drives the trust ding, applied
    // once the assignment's terminal state is settled so reliability reflects it.
    const missedByAssignment = new Map<string, number>();
    for (const s of overdue) {
      const won = await this.prisma.$transaction(async (tx) => {
        // Atomic claim: only the sweep that flips it out of a reclaimable state wins.
        const res = await tx.deliverySlot.updateMany({
          where: { id: s.id, status: { in: RECLAIMABLE_SLOT } },
          data: { status: DeliverySlotStatus.MISSED },
        });
        return res.count > 0;
      });
      if (won) {
        missed++;
        missedByAssignment.set(s.assignmentId, (missedByAssignment.get(s.assignmentId) ?? 0) + 1);
      }
    }

    // Re-roll each touched assignment's status, ding the no-shows, and re-allocate if
    // it now has two missed posts in a row (or a missed one-off) with reach owed.
    let reallocated = 0;
    for (const [assignmentId, missedThisSweep] of missedByAssignment) {
      if (await this.reconcileAfterMisses(assignmentId, missedThisSweep, now)) reallocated++;
    }

    if (missed > 0) this.logger.log(`Marked ${missed} missed post(s); re-allocated ${reallocated} assignment(s).`);
    return missed;
  }

  /**
   * After posts were marked MISSED, roll the assignment status up, ding the no-shows,
   * and decide whether to re-allocate. Returns true if the assignment was pulled and
   * re-offered. The trust ding runs AFTER the status update so the reliability cache
   * (lifetime PAID/CANCELLED) reflects the assignment's settled state.
   */
  private async reconcileAfterMisses(assignmentId: string, missedThisSweep: number, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const assignment = await tx.assignment.findUnique({
        where: { id: assignmentId },
        include: { deliverySlots: true, campaign: { select: { name: true } } },
      });
      if (!assignment || assignment.status === AssignmentStatus.CANCELLED) return false;

      const slotViews = assignment.deliverySlots.map((d) => ({ index: d.index, status: d.status }));
      const totalPosts = slotViews.length;
      const approved = slotViews.filter((v) => v.status === 'APPROVED').length;
      // Reach still owed to the client if this promoter is pulled = total − approved.
      // A replacement covers that deficit over the remaining window.
      const deficit = totalPosts - approved;
      // Pull + re-allocate when the promoter has failed: a one-off they missed, or
      // two scheduled posts missed back-to-back (§multi-day). A single non-consecutive
      // miss on a recurring campaign is just forfeited.
      const shouldReallocate =
        deficit > 0 && (totalPosts === 1 || hasConsecutiveMisses(slotViews, CONSECUTIVE_MISS_THRESHOLD));

      if (!shouldReallocate) {
        // Single miss (or non-consecutive): just forfeit and keep the rest going.
        const rollup = computeAssignmentRollup(slotViews);
        await tx.assignment.update({ where: { id: assignmentId }, data: { status: rollup.status } });
        // Ding after the status settles so the reliability cache is accurate.
        for (let i = 0; i < missedThisSweep; i++) {
          await this.scoring.recordDeliveryOutcome(assignment.promoterId, 'NO_SHOW', now, tx);
        }
        await this.notifications.create(
          {
            userId: assignment.promoterId,
            type: 'assignment.reclaimed',
            title: 'You missed a scheduled post',
            body: `A scheduled post on "${assignment.campaign.name}" passed its deadline and won't be paid. Keep the rest of your posts on time to protect your reliability.`,
            data: { assignmentId, campaignId: assignment.campaignId },
            dedupeKey: `post.missed:${assignmentId}:${slotViews.filter((v) => v.status === 'MISSED').length}`,
          },
          tx,
        );
        return false;
      }

      // Re-allocate: forfeit any still-open posts, pull the promoter off, and re-open
      // the campaign slot carrying the DEFICIT (total − approved) so a replacement
      // covers the reach still owed, over the remaining window.
      await tx.deliverySlot.updateMany({
        where: { assignmentId, status: { in: RECLAIMABLE_SLOT } },
        data: { status: DeliverySlotStatus.MISSED },
      });
      // Release the slot before clearing the FK: slotId is @unique, so the cancelled
      // assignment must let go of it before a replacement can reserve it.
      const slotId = assignment.slotId;
      await tx.assignment.update({
        where: { id: assignmentId },
        data: { status: AssignmentStatus.CANCELLED, slotId: null },
      });
      if (slotId) {
        await tx.campaignSlot.update({
          where: { id: slotId },
          data: { status: SlotStatus.OPEN, postsRequired: deficit },
        });
        await tx.campaign.update({ where: { id: assignment.campaignId }, data: { slotsFilled: { decrement: 1 } } });
      }
      // Ding after CANCELLED settles — the reliability cache now counts this as a
      // failed assignment. One ding per post actually missed this sweep (not the
      // future posts we force-forfeited on their behalf).
      for (let i = 0; i < missedThisSweep; i++) {
        await this.scoring.recordDeliveryOutcome(assignment.promoterId, 'NO_SHOW', now, tx);
      }
      const oneOff = totalPosts === 1;
      await this.notifications.create(
        {
          userId: assignment.promoterId,
          type: 'assignment.reclaimed',
          title: oneOff ? 'Assignment expired' : 'Assignment reassigned',
          body: oneOff
            ? `An assignment you accepted on "${assignment.campaign.name}" expired before you submitted proof, so it was returned to the pool. Missed deadlines lower your reliability — submit on time to keep it up.`
            : `You missed two scheduled posts in a row on "${assignment.campaign.name}", so its remaining posts were reassigned to keep the campaign on track. Missed deadlines lower your reliability.`,
          data: { assignmentId, campaignId: assignment.campaignId },
          dedupeKey: `assignment.reclaimed:${assignmentId}`,
        },
        tx,
      );
      return true;
    });
  }
}
