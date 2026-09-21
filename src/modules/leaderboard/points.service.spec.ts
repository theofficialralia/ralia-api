import { PrismaClient, Role } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PointsService } from './points.service';
import { seasonKeyFor } from './season';
import { testPrisma } from '../../../test/test-db';

describe('Leaderboard — Phase 0 foundations', () => {
  let prisma: PrismaClient;
  let points: PointsService;
  let seq = 0;

  beforeAll(() => {
    prisma = testPrisma();
    points = new PointsService(prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE point_events, users RESTART IDENTITY CASCADE');
  });

  async function makePromoter(): Promise<string> {
    const u = await prisma.user.create({
      data: { email: `p${seq++}@a.co`, phoneE164: `+23491${String(seq).padStart(8, '0')}`, passwordHash: 'x', status: 'ACTIVE', roles: { create: { role: Role.PROMOTER } } },
    });
    return u.id;
  }

  describe('seasonKeyFor', () => {
    it('is stable within a season and rolls over at the length boundary', () => {
      const start = new Date('2026-01-01T00:00:00Z'); // the epoch
      const day29 = new Date('2026-01-30T23:59:59Z'); // still season S0 at 30-day length
      const day30 = new Date('2026-01-31T00:00:00Z'); // first day of S1
      expect(seasonKeyFor(start, 30)).toBe('S0');
      expect(seasonKeyFor(day29, 30)).toBe('S0');
      expect(seasonKeyFor(day30, 30)).toBe('S1');
    });

    it('never resets when the length is zero', () => {
      expect(seasonKeyFor(new Date('2026-01-01T00:00:00Z'), 0)).toBe('ALL');
      expect(seasonKeyFor(new Date('2030-06-01T00:00:00Z'), 0)).toBe('ALL');
    });

    it('respects a different season length', () => {
      expect(seasonKeyFor(new Date('2026-01-07T00:00:00Z'), 7)).toBe('S0'); // day 6 → still the first weekly season
      expect(seasonKeyFor(new Date('2026-01-08T00:00:00Z'), 7)).toBe('S1'); // day 7 → second weekly season
    });
  });

  describe('award', () => {
    it('records a point event and returns true', async () => {
      const promoterId = await makePromoter();
      const created = await points.award({
        promoterId, type: 'DELIVERY_COMPLETED', points: 50,
        dedupeKey: 'DELIVERY_COMPLETED:sub-1', seasonKey: 'S9',
      });
      expect(created).toBe(true);
      const row = await prisma.pointEvent.findFirstOrThrow({ where: { promoterId } });
      expect(row.points).toBe(50);
      expect(row.type).toBe('DELIVERY_COMPLETED');
      expect(row.seasonKey).toBe('S9');
    });

    it('is idempotent on dedupeKey — a second award is ignored', async () => {
      const promoterId = await makePromoter();
      const key = 'OVER_DELIVERY:sub-7';
      const first = await points.award({ promoterId, type: 'OVER_DELIVERY', points: 40, dedupeKey: key, seasonKey: 'S9' });
      const second = await points.award({ promoterId, type: 'OVER_DELIVERY', points: 40, dedupeKey: key, seasonKey: 'S9' });
      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(await prisma.pointEvent.count({ where: { promoterId } })).toBe(1);
    });

    it('accepts negative points for penalties and reversals', async () => {
      const promoterId = await makePromoter();
      await points.award({ promoterId, type: 'PENALTY_NO_SHOW', points: -40, dedupeKey: 'PENALTY_NO_SHOW:a-1', seasonKey: 'S9' });
      const row = await prisma.pointEvent.findFirstOrThrow({ where: { promoterId } });
      expect(row.points).toBe(-40);
    });

    it('enlists in the caller’s transaction — a rollback drops the award', async () => {
      const promoterId = await makePromoter();
      await prisma
        .$transaction(async (tx) => {
          await points.award({ promoterId, type: 'QUALITY_CLEAN', points: 15, dedupeKey: 'QUALITY_CLEAN:sub-2', seasonKey: 'S9' }, tx);
          throw new Error('rollback');
        })
        .catch(() => undefined);
      expect(await prisma.pointEvent.count({ where: { promoterId } })).toBe(0);
    });
  });
});
