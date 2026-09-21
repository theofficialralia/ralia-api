import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { categoryForRole } from '../../common/pricing/pricing';
import { LeaderboardConfigService } from './leaderboard-config.service';
import { PointsService } from './points.service';
import { deliveryAwards } from './points-rules';
import { seasonKeyFor } from './season';
import { tierFor } from './tier';

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

const ROLLING_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Aggregates the point ledger into promoter_scores, ranks a season, and derives tiers
 * (docs/LEADERBOARD.md §5/§6/§9). The ledger stays the source of truth; everything here
 * is derived and rebuildable.
 *
 * - `recomputeScore` — refresh one promoter's rollup (called by the delivery hooks so
 *   their own card is live).
 * - `rebuildAll` — the nightly pass: recompute everyone (so inactivity decays rolling-90
 *   and tiers), then rank the current season and snapshot the global board.
 */
@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: LeaderboardConfigService,
    private readonly points: PointsService,
  ) {}

  /** Rebuild one promoter's score from the ledger (lifetime / season / rolling-90 /
   *  streak / tier) and mirror the tier onto the profile for the matching gate. */
  async recomputeScore(promoterId: string, now: Date = new Date(), client: Tx = this.prisma): Promise<void> {
    const config = await this.config.getActive();
    const seasonKey = seasonKeyFor(now, config.seasonLengthDays);
    const rollingSince = new Date(now.getTime() - ROLLING_WINDOW_MS);

    const [lifetime, season, rolling, outcomes, profile] = await Promise.all([
      client.pointEvent.aggregate({ where: { promoterId }, _sum: { points: true } }),
      client.pointEvent.aggregate({ where: { promoterId, seasonKey }, _sum: { points: true } }),
      client.pointEvent.aggregate({ where: { promoterId, occurredAt: { gte: rollingSince } }, _sum: { points: true } }),
      // Trailing consecutive on-time deliveries — a miss or rejection breaks the streak.
      client.pointEvent.findMany({
        where: { promoterId, type: { in: ['DELIVERED_ON_TIME', 'PENALTY_NO_SHOW', 'PENALTY_REJECTED'] } },
        orderBy: { occurredAt: 'desc' },
        select: { type: true },
      }),
      client.promoterProfile.findUnique({ where: { userId: promoterId }, select: { reliability: true } }),
    ]);

    let streak = 0;
    for (const o of outcomes) {
      if (o.type === 'DELIVERED_ON_TIME') streak++;
      else break;
    }

    const lifetimePoints = lifetime._sum.points ?? 0;
    const seasonPoints = season._sum.points ?? 0;
    const rolling90Points = rolling._sum.points ?? 0;
    const reliability = profile?.reliability.toNumber() ?? 0;
    const tier = tierFor(rolling90Points, reliability, config);

    await client.promoterScore.upsert({
      where: { promoterId },
      create: { promoterId, lifetimePoints, seasonKey, seasonPoints, rolling90Points, streak, tier },
      update: { lifetimePoints, seasonKey, seasonPoints, rolling90Points, streak, tier },
    });
    // Mirror the tier onto the profile so matching can gate campaigns without a join.
    if (profile) {
      await client.promoterProfile.update({ where: { userId: promoterId }, data: { tier } });
    }
  }

  /**
   * The nightly pass. Recompute every promoter who has ever earned a point (so aged-out
   * rolling-90 points decay tiers even without new activity), then rank the current
   * season and replace the global snapshot.
   */
  async rebuildAll(now: Date = new Date()): Promise<{ promoters: number; ranked: number }> {
    const config = await this.config.getActive();
    const seasonKey = seasonKeyFor(now, config.seasonLengthDays);

    const promoters = await this.prisma.pointEvent.findMany({ distinct: ['promoterId'], select: { promoterId: true } });
    for (const { promoterId } of promoters) {
      await this.recomputeScore(promoterId, now, this.prisma);
    }

    // Rank the current season by season points (tie-break: earlier-updated first).
    const scores = await this.prisma.promoterScore.findMany({
      where: { seasonKey },
      orderBy: [{ seasonPoints: 'desc' }, { updatedAt: 'asc' }],
      select: { promoterId: true, seasonPoints: true },
    });

    await this.prisma.$transaction(async (tx) => {
      // Replace the current season's global snapshot with the fresh standing.
      await tx.leaderboardSnapshot.deleteMany({ where: { seasonKey, scope: 'GLOBAL' } });
      let rank = 0;
      for (const s of scores) {
        rank++;
        await tx.promoterScore.update({ where: { promoterId: s.promoterId }, data: { rank } });
        await tx.leaderboardSnapshot.create({
          data: { seasonKey, scope: 'GLOBAL', promoterId: s.promoterId, rank, points: s.seasonPoints },
        });
      }
    });

    this.logger.log(`Leaderboard rebuilt: ${promoters.length} promoters, ${scores.length} ranked (${seasonKey}).`);
    return { promoters: promoters.length, ranked: scores.length };
  }

  /**
   * One-off launch backfill: replay the DELIVERY awards for every already-approved
   * submission (idempotent via the ledger dedupe key `<type>:<submissionId>`, so it's
   * safe to re-run), then rebuild. Historical penalties are not reconstructed — only the
   * positive delivery points, which is what the boards need to not launch empty.
   */
  async backfill(now: Date = new Date()): Promise<{ submissions: number; awarded: number }> {
    const config = await this.config.getActive();
    const subs = await this.prisma.submission.findMany({
      where: { verdict: 'APPROVED', verifiedReach: { not: null } },
      include: { assignment: true, deliverySlot: true },
    });

    let awarded = 0;
    for (const s of subs) {
      const a = s.assignment;
      const promised = s.deliverySlot?.promisedReach ?? a.promisedReach;
      if (promised <= 0 || s.verifiedReach == null) continue;
      const occurredAt = s.reviewedAt ?? s.submittedAt;
      const seasonKey = seasonKeyFor(occurredAt, config.seasonLengthDays);
      const awards = deliveryAwards(config, {
        verified: s.verifiedReach,
        promised,
        onTime: a.deliveredOnTime ?? true,
        autoFlag: s.autoFlag,
        isCreation: categoryForRole(a.role) === 'CREATION',
      });
      for (const aw of awards) {
        const created = await this.points.award({
          promoterId: a.promoterId,
          type: aw.type,
          points: aw.points,
          dedupeKey: `${aw.type}:${s.id}`,
          seasonKey,
          submissionId: s.id,
          assignmentId: a.id,
          campaignId: a.campaignId,
          occurredAt,
        });
        if (created) awarded++;
      }
    }

    await this.rebuildAll(now);
    this.logger.log(`Leaderboard backfill: ${subs.length} approved submissions, ${awarded} new awards.`);
    return { submissions: subs.length, awarded };
  }
}
