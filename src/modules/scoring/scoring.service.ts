import { Injectable } from '@nestjs/common';
import { AssignmentStatus, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  DEFAULT_SCORING_CONFIG,
  ScoringConfig,
  TrustEvent,
  applyTrustEvent,
  reliabilityScore,
} from '../../common/scoring/scoring';

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
