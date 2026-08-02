import { Injectable, Logger } from '@nestjs/common';
import { AssignmentStatus, CampaignStatus, OfferStatus, SlotStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateConfigService } from '../../common/rate-config/rate-config.service';
import { DEFAULT_SCORING_CONFIG, overOfferCount } from '../../common/scoring/scoring';
import { MatchingService } from '../matching/matching.service';
import { ScoringService } from '../scoring/scoring.service';

/** Assignment states a promoter can still act on — the ones a missed deadline reclaims. */
const RECLAIMABLE: AssignmentStatus[] = [AssignmentStatus.IN_PROGRESS, AssignmentStatus.REJECTED];

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
   * Reclaim assignments that missed their delivery deadline without acceptable proof.
   * SUBMITTED assignments are deliberately spared — the promoter delivered and is
   * waiting on review; only IN_PROGRESS / REJECTED (they had the chance and didn't
   * deliver in time) are reclaimed. Each reclaim is its own transaction, and the
   * CANCELLED transition is guarded by a status-conditional updateMany so two
   * overlapping sweeps can't both release the same slot or double-ding the promoter.
   */
  async reclaimOverdueAssignments(now: Date): Promise<number> {
    const overdue = await this.prisma.assignment.findMany({
      where: { status: { in: RECLAIMABLE }, dueAt: { lt: now } },
      select: { id: true, promoterId: true, slotId: true, campaignId: true },
    });

    let reclaimed = 0;
    for (const a of overdue) {
      const won = await this.prisma.$transaction(async (tx) => {
        // Atomic claim: only the sweep that flips it out of a reclaimable state wins.
        const res = await tx.assignment.updateMany({
          where: { id: a.id, status: { in: RECLAIMABLE } },
          data: { status: AssignmentStatus.CANCELLED },
        });
        if (res.count === 0) return false;

        // Return the slot to the pool so another promoter's live offer can fill it.
        if (a.slotId) {
          await tx.campaignSlot.update({ where: { id: a.slotId }, data: { status: SlotStatus.OPEN } });
        }
        await tx.campaign.update({ where: { id: a.campaignId }, data: { slotsFilled: { decrement: 1 } } });

        // No-show: the steepest trust penalty (−10, §4), plus a reliability recompute.
        await this.scoring.recordDeliveryOutcome(a.promoterId, 'NO_SHOW', now, tx);
        return true;
      });
      if (won) reclaimed++;
    }

    if (reclaimed > 0) this.logger.log(`Reclaimed ${reclaimed} overdue assignment(s).`);
    return reclaimed;
  }
}
