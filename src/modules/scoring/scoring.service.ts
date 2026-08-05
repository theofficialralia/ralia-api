import { Injectable } from '@nestjs/common';
import { AssignmentStatus, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  DEFAULT_SCORING_CONFIG,
  ScoringConfig,
  TrustEvent,
  applyTrustEvent,
  capabilityRoleForName,
  capabilityScore,
  proofStrength,
  reliabilityScore,
} from '../../common/scoring/scoring';

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** A Prisma client or an interactive-transaction client — mirrors LedgerService. */
type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export type ReputationSnapshot = {
  trust: number;
  reliability: number;
  completedDeliveries: number;
};

const ROLLING_WINDOW_DAYS = 60;

/**
 * The DB-facing reputation engine (ALGORITHMS.md §4/§5). It owns the *persistence*
 * of the pure scoring rules in src/common/scoring: it applies a trust delta for a
 * delivery outcome and re-derives the reliability cache from assignment history,
 * always inside the caller's transaction so reputation moves atomically with the
 * money it accompanies.
 */
@Injectable()
export class ScoringService {
  private readonly config: ScoringConfig = DEFAULT_SCORING_CONFIG;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reliability (§5) recomputed from terminal assignment outcomes:
   *   - lifetime_completion_rate = PAID / (PAID + CANCELLED)         [terminal only]
   *   - rolling_ontime_rate(60d) = on-time PAID / all PAID paid in the last 60 days
   * Also returns the lifetime completed (PAID) count for the "proven" newbie test.
   * With no terminal history at all the blend falls back to the neutral 0.5.
   */
  async computeReliability(promoterId: string, now: Date, tx: Tx): Promise<{ reliability: number; completedDeliveries: number }> {
    const windowStart = new Date(now.getTime() - ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const [paid, cancelled, rollingTotal, rollingOnTime] = await Promise.all([
      tx.assignment.count({ where: { promoterId, status: AssignmentStatus.PAID } }),
      tx.assignment.count({ where: { promoterId, status: AssignmentStatus.CANCELLED } }),
      tx.assignment.count({ where: { promoterId, status: AssignmentStatus.PAID, paidAt: { gte: windowStart } } }),
      tx.assignment.count({
        where: { promoterId, status: AssignmentStatus.PAID, deliveredOnTime: true, paidAt: { gte: windowStart } },
      }),
    ]);

    const lifetimeTerminal = paid + cancelled;
    const lifetimeRate = lifetimeTerminal > 0 ? paid / lifetimeTerminal : null;
    const rollingRate = rollingTotal > 0 ? rollingOnTime / rollingTotal : null;

    return {
      reliability: reliabilityScore(rollingRate, lifetimeRate, this.config),
      completedDeliveries: paid,
    };
  }

  /**
   * Computes per-role capability (§3) from the promoter's self-reported factors plus
   * the derived ones — verified reach and proof strength from their best active channel,
   * and admin sample ratings (default 0.5 until an admin rates). Returned as a
   * {role: 0–100} map for the roles the promoter offers; empty if they offer none.
   */
  async computeCapability(
    promoterId: string,
    opts: { sampleRatings?: number },
    tx: Tx,
  ): Promise<Record<string, number>> {
    const profile = await tx.promoterProfile.findUnique({
      where: { userId: promoterId },
      select: { roles: true, capabilityInputs: true },
    });
    if (!profile) return {};

    const bestChannel = await tx.channel.findFirst({
      where: { promoterId },
      orderBy: { effectiveReach: 'desc' },
      select: { effectiveReach: true, verificationTier: true },
    });

    const selfReported = (profile.capabilityInputs as Record<string, number> | null) ?? {};
    const derived = {
      verifiedReach: bestChannel ? clamp01(bestChannel.effectiveReach / this.config.capabilityReachReference) : 0,
      recentPostProof: bestChannel ? proofStrength(bestChannel.verificationTier) : 0.5,
      ratedSamples: opts.sampleRatings ?? 0.5,
    };
    const factors = { ...selfReported, ...derived };

    const scores: Record<string, number> = {};
    for (const role of profile.roles) {
      scores[role] = capabilityScore(capabilityRoleForName(role), factors, undefined);
    }
    return scores;
  }

  /**
   * Records a delivery outcome for a promoter: applies the asymmetric trust delta,
   * recomputes the reliability + completed-count cache, and persists all three.
   * The caller passes its transaction client so this commits with the settlement.
   */
  async recordDeliveryOutcome(promoterId: string, event: TrustEvent, now: Date, tx: Tx): Promise<ReputationSnapshot> {
    const profile = await tx.promoterProfile.findUnique({
      where: { userId: promoterId },
      select: { trustScore: true },
    });
    // A promoter with no profile row can't have earned an offer — but never let a
    // reputation update be the thing that fails a settlement.
    if (!profile) {
      return { trust: 0, reliability: this.config.reliability.noHistory, completedDeliveries: 0 };
    }

    const trust = applyTrustEvent(profile.trustScore.toNumber(), event, this.config);
    const { reliability, completedDeliveries } = await this.computeReliability(promoterId, now, tx);

    await tx.promoterProfile.update({
      where: { userId: promoterId },
      data: { trustScore: trust, reliability, completedDeliveries },
    });

    return { trust, reliability, completedDeliveries };
  }
}
