import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PointEventType, PrismaClient, PromoterStatus, Role } from '@prisma/client';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeaderboardConfigService } from './leaderboard-config.service';
import { LeaderboardService } from './leaderboard.service';
import { PointsService } from './points.service';
import { seasonKeyFor } from './season';
import { testPrisma } from '../../../test/test-db';

describe('LeaderboardService (Phase 2)', () => {
  let prisma: PrismaClient;
  let service: LeaderboardService;
  let seq = 0;
  const NOW = new Date('2026-06-15T12:00:00Z');
  const SEASON = seasonKeyFor(NOW, 30);

  beforeAll(async () => {
    prisma = testPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
      providers: [LeaderboardService, LeaderboardConfigService, PointsService],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    service = moduleRef.get(LeaderboardService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE point_events, promoter_scores, leaderboard_snapshots, promoter_profiles, users, leaderboard_config RESTART IDENTITY CASCADE');
    await prisma.leaderboardConfig.create({ data: {} });
  });

  async function makePromoter(reliability = 0.9, fullName: string | null = null): Promise<string> {
    const u = await prisma.user.create({
      data: { email: `p${seq++}@a.co`, phoneE164: `+23491${String(seq).padStart(8, '0')}`, passwordHash: 'x', status: 'ACTIVE', roles: { create: { role: Role.PROMOTER } } },
    });
    await prisma.promoterProfile.create({ data: { userId: u.id, status: PromoterStatus.ACTIVE, reliability, fullName } });
    return u.id;
  }

  function event(promoterId: string, type: PointEventType, points: number, occurredAt: Date, seasonKey = SEASON) {
    return prisma.pointEvent.create({ data: { promoterId, type, points, occurredAt, seasonKey, dedupeKey: `${type}:${promoterId}:${occurredAt.getTime()}:${points}` } });
  }

  it('rolls up lifetime / season / rolling / streak and mirrors the tier to the profile', async () => {
    const p = await makePromoter();
    await event(p, 'DELIVERY_COMPLETED', 50, NOW);
    await event(p, 'DELIVERED_ON_TIME', 20, NOW);
    await event(p, 'OVER_DELIVERY', 30, NOW);

    await service.recomputeScore(p, NOW);

    const s = await prisma.promoterScore.findUniqueOrThrow({ where: { promoterId: p } });
    expect(s.lifetimePoints).toBe(100);
    expect(s.seasonPoints).toBe(100);
    expect(s.rolling90Points).toBe(100);
    expect(s.seasonKey).toBe(SEASON);
    expect(s.streak).toBe(1); // one trailing on-time
    expect(s.tier).toBe('BRONZE'); // 100 < silver threshold (300)
    // Mirrored onto the profile for the matching gate.
    expect((await prisma.promoterProfile.findUniqueOrThrow({ where: { userId: p } })).tier).toBe('BRONZE');
  });

  it('derives tier from rolling-90 with a reliability floor for the top tiers', async () => {
    const strong = await makePromoter(0.9); // clears the floor
    const flaky = await makePromoter(0.5); // below the floor
    await event(strong, 'ADJUSTMENT', 900, NOW);
    await event(flaky, 'ADJUSTMENT', 900, NOW);

    await service.recomputeScore(strong, NOW);
    await service.recomputeScore(flaky, NOW);

    // 900 ≥ gold (800): reliable → GOLD; unreliable falls back to SILVER (≥ 300).
    expect((await prisma.promoterScore.findUniqueOrThrow({ where: { promoterId: strong } })).tier).toBe('GOLD');
    expect((await prisma.promoterScore.findUniqueOrThrow({ where: { promoterId: flaky } })).tier).toBe('SILVER');
  });

  it('counts the trailing on-time streak, broken by a miss or rejection', async () => {
    const p = await makePromoter();
    const t = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    await event(p, 'DELIVERED_ON_TIME', 20, t(4));
    await event(p, 'PENALTY_NO_SHOW', -40, t(3));
    await event(p, 'DELIVERED_ON_TIME', 20, t(2));
    await event(p, 'DELIVERED_ON_TIME', 20, t(1)); // most recent

    await service.recomputeScore(p, NOW);
    expect((await prisma.promoterScore.findUniqueOrThrow({ where: { promoterId: p } })).streak).toBe(2);
  });

  it('ages out rolling-90 points so tiers decay, while lifetime keeps them', async () => {
    const p = await makePromoter();
    await event(p, 'ADJUSTMENT', 500, new Date(NOW.getTime() - 100 * 86_400_000)); // 100 days ago
    await event(p, 'DELIVERY_COMPLETED', 50, NOW);

    await service.recomputeScore(p, NOW);
    const s = await prisma.promoterScore.findUniqueOrThrow({ where: { promoterId: p } });
    expect(s.lifetimePoints).toBe(550); // both count for lifetime
    expect(s.rolling90Points).toBe(50); // the 100-day-old award has aged out
    expect(s.tier).toBe('BRONZE'); // 50 rolling → decayed below Silver
  });

  it('rebuildAll ranks the season and writes the global snapshot', async () => {
    const a = await makePromoter();
    const b = await makePromoter();
    await event(a, 'ADJUSTMENT', 400, NOW);
    await event(b, 'ADJUSTMENT', 100, NOW);

    const res = await service.rebuildAll(NOW);
    expect(res.ranked).toBe(2);

    expect((await prisma.promoterScore.findUniqueOrThrow({ where: { promoterId: a } })).rank).toBe(1);
    expect((await prisma.promoterScore.findUniqueOrThrow({ where: { promoterId: b } })).rank).toBe(2);

    const snap = await prisma.leaderboardSnapshot.findMany({ where: { seasonKey: SEASON, scope: 'GLOBAL' }, orderBy: { rank: 'asc' } });
    expect(snap.map((r) => r.promoterId)).toEqual([a, b]);
    expect(snap[0]?.points).toBe(400);
  });

  it('board returns the ranked top with privacy-preserving names and the viewer’s row', async () => {
    const a = await makePromoter(0.9, 'Ada Okafor');
    const b = await makePromoter(0.9, 'Ben Lawal');
    await event(a, 'ADJUSTMENT', 400, NOW);
    await event(b, 'ADJUSTMENT', 100, NOW);
    await service.recomputeScore(a, NOW);
    await service.recomputeScore(b, NOW);

    const board = await service.board(a, 10, NOW);
    expect(board.season).toBe(SEASON);
    expect(board.total).toBe(2);
    expect(board.top[0]).toMatchObject({ rank: 1, display_name: 'Ada O.', points: 400, is_me: true });
    expect(board.top[1]).toMatchObject({ rank: 2, display_name: 'Ben L.', is_me: false });
    expect(board.me).toMatchObject({ rank: 1, points: 400, is_me: true });
  });

  it('myScore reports rank, tier, progress to next tier, and a breakdown', async () => {
    const a = await makePromoter(0.9, 'Ada Okafor');
    await event(a, 'DELIVERY_COMPLETED', 300, NOW);
    await event(a, 'OVER_DELIVERY', 100, NOW);
    await service.recomputeScore(a, NOW);

    const me = await service.myScore(a, NOW);
    expect(me.season_points).toBe(400);
    expect(me.rank).toBe(1);
    expect(me.tier).toBe('SILVER'); // 400 ≥ silver (300)
    expect(me.next_tier).toMatchObject({ tier: 'GOLD', points_to_go: 400 }); // 800 − 400
    expect(me.breakdown.map((b) => b.type)).toEqual(['DELIVERY_COMPLETED', 'OVER_DELIVERY']);
  });
});
