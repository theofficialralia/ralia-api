import { Injectable, Logger } from '@nestjs/common';
import { LeaderboardConfig, PrismaClient, PromoterTier } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { categoryForRole } from '../../common/pricing/pricing';
import { LeaderboardConfigService } from './leaderboard-config.service';
import { PointsService } from './points.service';
import { deliveryAwards } from './points-rules';
import { seasonKeyFor } from './season';
import { tierFor } from './tier';
import { LeaderboardDto, LeaderboardRowDto, MyScoreDto, NextTierDto } from './dto/leaderboard.dto';

/** Privacy-preserving display name: first name + last initial (e.g. "Ada O."). */
function displayName(fullName: string | null): string {
  if (!fullName?.trim()) return 'Promoter';
  const parts = fullName.trim().split(/\s+/);
  const first = parts[0] ?? 'Promoter';
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}

/** The next tier up and the rolling-90 points still needed, or null at the top. */
function nextTierProgress(tier: PromoterTier, rolling90: number, config: LeaderboardConfig): NextTierDto | null {
  if (tier === 'BRONZE') return { tier: 'SILVER', points_to_go: Math.max(0, config.tierSilverAt - rolling90) };
  if (tier === 'SILVER') return { tier: 'GOLD', points_to_go: Math.max(0, config.tierGoldAt - rolling90) };
  if (tier === 'GOLD') return { tier: 'PLATINUM', points_to_go: Math.max(0, config.tierPlatinumAt - rolling90) };
  return null;
}

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

  // ── Reads (promoter-facing, Phase 3) ─────────────────────

  /** The full season standings for admins — real names, season + lifetime points,
   *  tier and streak, ranked. Not privacy-masked (admin-only). */
  async adminBoard(limit: number, now: Date = new Date()): Promise<import('./dto/leaderboard.dto').AdminLeaderboardDto> {
    const seasonKey = await this.config.currentSeasonKey(now);
    const [scores, total] = await Promise.all([
      this.prisma.promoterScore.findMany({
        where: { seasonKey },
        orderBy: [{ seasonPoints: 'desc' }, { updatedAt: 'asc' }],
        take: limit,
        select: { promoterId: true, seasonPoints: true, lifetimePoints: true, tier: true, streak: true },
      }),
      this.prisma.promoterScore.count({ where: { seasonKey } }),
    ]);
    const profiles = await this.prisma.promoterProfile.findMany({
      where: { userId: { in: scores.map((s) => s.promoterId) } },
      select: { userId: true, fullName: true },
    });
    const nameOf = new Map(profiles.map((p) => [p.userId, p.fullName]));
    return {
      season: seasonKey,
      total,
      rows: scores.map((s, i) => ({
        rank: i + 1,
        promoter_id: s.promoterId,
        full_name: nameOf.get(s.promoterId) ?? null,
        season_points: s.seasonPoints,
        lifetime_points: s.lifetimePoints,
        tier: s.tier,
        streak: s.streak,
      })),
    };
  }

  /** The point values, for a promoter-facing "how points work" panel. */
  async rules(): Promise<import('./dto/leaderboard.dto').PointRulesDto> {
    const c = await this.config.getActive();
    return {
      delivery_completed: c.ptsDeliveryCompleted,
      on_time: c.ptsOnTime,
      quality_clean: c.ptsQualityClean,
      over_delivery_max: c.overBase * (c.overCapRatio - 1),
      over_cap_ratio: c.overCapRatio,
      penalty_no_show: c.penaltyNoShow,
      penalty_rejected: c.penaltyRejected,
      penalty_duplicate: c.penaltyDuplicate,
    };
  }

  private async displayNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const profiles = await this.prisma.promoterProfile.findMany({
      where: { userId: { in: unique } },
      select: { userId: true, fullName: true },
    });
    return new Map(profiles.map((p) => [p.userId, displayName(p.fullName)]));
  }

  /** The season board: the top promoters (live order by season points) plus the
   *  viewer's own ranked row. */
  async board(viewerId: string, limit: number, now: Date = new Date()): Promise<LeaderboardDto> {
    const seasonKey = await this.config.currentSeasonKey(now);
    const [rows, total, mine] = await Promise.all([
      this.prisma.promoterScore.findMany({
        where: { seasonKey },
        orderBy: [{ seasonPoints: 'desc' }, { updatedAt: 'asc' }],
        take: limit,
        select: { promoterId: true, seasonPoints: true, tier: true },
      }),
      this.prisma.promoterScore.count({ where: { seasonKey } }),
      this.prisma.promoterScore.findUnique({
        where: { promoterId: viewerId },
        select: { promoterId: true, seasonKey: true, seasonPoints: true, tier: true },
      }),
    ]);

    const inSeason = mine?.seasonKey === seasonKey ? mine : null;
    const names = await this.displayNames([...rows.map((r) => r.promoterId), ...(inSeason ? [inSeason.promoterId] : [])]);

    const top: LeaderboardRowDto[] = rows.map((r, i) => ({
      rank: i + 1,
      display_name: names.get(r.promoterId) ?? 'Promoter',
      points: r.seasonPoints,
      tier: r.tier,
      is_me: r.promoterId === viewerId,
    }));

    let me: LeaderboardRowDto | null = null;
    if (inSeason) {
      const better = await this.prisma.promoterScore.count({ where: { seasonKey, seasonPoints: { gt: inSeason.seasonPoints } } });
      me = { rank: better + 1, display_name: names.get(inSeason.promoterId) ?? 'You', points: inSeason.seasonPoints, tier: inSeason.tier, is_me: true };
    }

    return { season: seasonKey, total, top, me };
  }

  /** The viewer's own score card: totals, rank, tier + progress, streak, breakdown. */
  async myScore(promoterId: string, now: Date = new Date()): Promise<MyScoreDto> {
    const config = await this.config.getActive();
    const seasonKey = seasonKeyFor(now, config.seasonLengthDays);
    const [score, breakdownRaw] = await Promise.all([
      this.prisma.promoterScore.findUnique({ where: { promoterId } }),
      this.prisma.pointEvent.groupBy({ by: ['type'], where: { promoterId, seasonKey }, _sum: { points: true } }),
    ]);

    const inSeason = score?.seasonKey === seasonKey ? score : null;
    const rolling90 = score?.rolling90Points ?? 0;
    const tier = score?.tier ?? 'BRONZE';

    let rank: number | null = null;
    if (inSeason) {
      const better = await this.prisma.promoterScore.count({ where: { seasonKey, seasonPoints: { gt: inSeason.seasonPoints } } });
      rank = better + 1;
    }

    const breakdown = breakdownRaw
      .map((b) => ({ type: b.type, points: b._sum.points ?? 0 }))
      .filter((b) => b.points !== 0)
      .sort((a, b) => b.points - a.points);

    return {
      season: seasonKey,
      season_points: inSeason?.seasonPoints ?? 0,
      lifetime_points: score?.lifetimePoints ?? 0,
      rolling_90_points: rolling90,
      rank,
      tier,
      next_tier: nextTierProgress(tier, rolling90, config),
      streak: score?.streak ?? 0,
      breakdown,
    };
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
