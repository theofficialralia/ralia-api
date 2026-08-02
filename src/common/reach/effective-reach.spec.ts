import { Platform, VerificationTier } from '@prisma/client';
import {
  channelEffectiveReach,
  computeEffectiveReach,
  currentTier,
  DEFAULT_REACH_FACTORS,
  ReachPolicy,
} from './effective-reach';

/**
 * §5.1: effective_reach = round(claimed × platform_factor × verification_factor)
 *
 * Every expected number below is worked by hand from the handoff's table, not
 * from the implementation — a test that recomputes the formula it is testing
 * proves only that multiplication works.
 */
describe('effective reach (§5.1)', () => {
  describe('the platform factor table', () => {
    // claimed 1000, SCREENSHOT (factor 1.0), so the result is the platform factor × 1000.
    it.each<[Platform, number]>([
      [Platform.WHATSAPP_STATUS, 300],
      [Platform.WHATSAPP_GROUP, 200],
      [Platform.TELEGRAM, 200],
      [Platform.INSTAGRAM, 100],
      [Platform.FACEBOOK, 100],
      [Platform.TIKTOK, 120],
      [Platform.X, 50],
      [Platform.LINKEDIN, 120],
      [Platform.OFFLINE, 150],
    ])('%s discounts 1000 claimed to %i', (platform, expected) => {
      expect(computeEffectiveReach(1000, platform, VerificationTier.SCREENSHOT)).toBe(expected);
    });
  });

  describe('the verification factor', () => {
    // Instagram (0.10) × 10,000 claimed = 1000 before the tier is applied.
    it.each<[VerificationTier, number]>([
      [VerificationTier.SELF, 600],
      [VerificationTier.SCREENSHOT, 1000],
      [VerificationTier.INSIGHTS, 1150],
    ])('%s scales 1000 to %i', (tier, expected) => {
      expect(computeEffectiveReach(10_000, Platform.INSTAGRAM, tier)).toBe(expected);
    });
  });

  describe('worked examples', () => {
    it('a self-reported WhatsApp status of 500 pays on 90', () => {
      // 500 × 0.30 × 0.6 = 90
      expect(computeEffectiveReach(500, Platform.WHATSAPP_STATUS, VerificationTier.SELF)).toBe(90);
    });

    it('an insights-verified TikTok of 45,000 pays on 6,210', () => {
      // 45000 × 0.12 × 1.15 = 6210
      expect(computeEffectiveReach(45_000, Platform.TIKTOK, VerificationTier.INSIGHTS)).toBe(6210);
    });

    it('a self-reported X account of 30,000 pays on 900', () => {
      // 30000 × 0.05 × 0.6 = 900 — X is discounted hardest, by design.
      expect(computeEffectiveReach(30_000, Platform.X, VerificationTier.SELF)).toBe(900);
    });
  });

  describe('rounding', () => {
    it('rounds rather than truncates', () => {
      // 55 × 0.05 × 1.0 = 2.75 → 3
      expect(computeEffectiveReach(55, Platform.X, VerificationTier.SCREENSHOT)).toBe(3);
      // 45 × 0.05 × 1.0 = 2.25 → 2
      expect(computeEffectiveReach(45, Platform.X, VerificationTier.SCREENSHOT)).toBe(2);
    });

    it('never returns a fraction', () => {
      for (let claimed = 0; claimed < 200; claimed++) {
        const reach = computeEffectiveReach(claimed, Platform.TIKTOK, VerificationTier.INSIGHTS);
        expect(Number.isInteger(reach)).toBe(true);
      }
    });
  });

  describe('edges', () => {
    it('zero claimed is zero reach', () => {
      expect(computeEffectiveReach(0, Platform.WHATSAPP_STATUS, VerificationTier.INSIGHTS)).toBe(0);
    });

    it('rejects a negative claim', () => {
      expect(() => computeEffectiveReach(-1, Platform.INSTAGRAM, VerificationTier.SELF)).toThrow(
        /non-negative/,
      );
    });

    it('rejects a non-finite claim', () => {
      expect(() => computeEffectiveReach(NaN, Platform.INSTAGRAM, VerificationTier.SELF)).toThrow();
      expect(() => computeEffectiveReach(Infinity, Platform.INSTAGRAM, VerificationTier.SELF)).toThrow();
    });

    it('never exceeds the claim — the factors only ever discount', () => {
      // The largest possible product is 0.30 × 1.15 = 0.345, so reach is always
      // well under what was claimed. If this fails, someone raised a factor past
      // 1/1.15 and promoters are being paid on more than they say they have.
      for (const platform of Object.values(Platform)) {
        for (const tier of Object.values(VerificationTier)) {
          const reach = computeEffectiveReach(10_000, platform, tier);
          expect(reach).toBeLessThan(10_000);
        }
      }
    });
  });

  describe('factors are injectable', () => {
    it('uses the supplied factors over the defaults', () => {
      const doubled = {
        platform: { ...DEFAULT_REACH_FACTORS.platform, [Platform.INSTAGRAM]: 0.2 },
        tier: DEFAULT_REACH_FACTORS.tier,
      };
      expect(computeEffectiveReach(1000, Platform.INSTAGRAM, VerificationTier.SCREENSHOT, doubled)).toBe(200);
      // The default is untouched by the override.
      expect(computeEffectiveReach(1000, Platform.INSTAGRAM, VerificationTier.SCREENSHOT)).toBe(100);
    });
  });
});

/**
 * §1 policy on top of the flat core: group basis, the self-reported cap, and
 * proof decay. Every expected number is worked by hand.
 */
describe('reach policy (§1)', () => {
  const POLICY: ReachPolicy = {
    factors: DEFAULT_REACH_FACTORS,
    unverifiedReachCap: 2000,
    proofValidityDays: 90,
  };
  const NOW = new Date('2026-08-02T00:00:00Z');
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  const base = {
    platform: Platform.INSTAGRAM,
    claimedAudience: 100_000,
    isGroup: false,
    activeParticipants: null as number | null,
    verificationTier: VerificationTier.SELF,
    verifiedAt: null as Date | null,
  };

  describe('group basis', () => {
    it('counts active participants, not total members', () => {
      // WhatsApp group 0.20 × active 500 × screenshot 1.0 = 100 — NOT the 1000 the
      // 5,000 members would give.
      const reach = channelEffectiveReach(
        { platform: Platform.WHATSAPP_GROUP, claimedAudience: 5000, isGroup: true, activeParticipants: 500, verificationTier: VerificationTier.SCREENSHOT, verifiedAt: daysAgo(1) },
        POLICY,
        NOW,
      );
      expect(reach).toBe(100);
    });

    it('a group with no active count is worth nothing', () => {
      const reach = channelEffectiveReach(
        { platform: Platform.TELEGRAM, claimedAudience: 9000, isGroup: true, activeParticipants: null, verificationTier: VerificationTier.SCREENSHOT, verifiedAt: daysAgo(1) },
        POLICY,
        NOW,
      );
      expect(reach).toBe(0);
    });
  });

  describe('the self-reported cap', () => {
    it('caps self-reported reach at the ceiling', () => {
      // 100000 × 0.10 × 0.6 = 6000, capped to 2000.
      expect(channelEffectiveReach(base, POLICY, NOW)).toBe(2000);
    });

    it('a verified proof lifts the cap', () => {
      // 100000 × 0.10 × 1.0 = 10000, uncapped.
      const reach = channelEffectiveReach({ ...base, verificationTier: VerificationTier.SCREENSHOT, verifiedAt: daysAgo(10) }, POLICY, NOW);
      expect(reach).toBe(10_000);
    });

    it('does not cap when self-reported reach is already under the ceiling', () => {
      // 5000 × 0.10 × 0.6 = 300.
      expect(channelEffectiveReach({ ...base, claimedAudience: 5000 }, POLICY, NOW)).toBe(300);
    });
  });

  describe('proof decay', () => {
    it('a fresh proof keeps its multiplier', () => {
      expect(channelEffectiveReach({ ...base, verificationTier: VerificationTier.INSIGHTS, verifiedAt: daysAgo(30) }, POLICY, NOW)).toBe(11_500);
    });

    it('a stale proof decays to self-reported and is capped', () => {
      // 100 days > 90 → SELF → 6000 capped to 2000.
      expect(channelEffectiveReach({ ...base, verificationTier: VerificationTier.SCREENSHOT, verifiedAt: daysAgo(100) }, POLICY, NOW)).toBe(2000);
    });

    it('a verified tier with no proof timestamp is treated as unproven', () => {
      expect(channelEffectiveReach({ ...base, verificationTier: VerificationTier.INSIGHTS, verifiedAt: null }, POLICY, NOW)).toBe(2000);
    });
  });

  describe('currentTier', () => {
    it('SELF stays SELF', () => {
      expect(currentTier(VerificationTier.SELF, daysAgo(1), 90, NOW)).toBe(VerificationTier.SELF);
    });
    it('the validity boundary is inclusive (exactly 90 days still counts)', () => {
      expect(currentTier(VerificationTier.SCREENSHOT, daysAgo(90), 90, NOW)).toBe(VerificationTier.SCREENSHOT);
      expect(currentTier(VerificationTier.SCREENSHOT, daysAgo(91), 90, NOW)).toBe(VerificationTier.SELF);
    });
    it('a verified tier with no timestamp decays', () => {
      expect(currentTier(VerificationTier.INSIGHTS, null, 90, NOW)).toBe(VerificationTier.SELF);
    });
  });
});
