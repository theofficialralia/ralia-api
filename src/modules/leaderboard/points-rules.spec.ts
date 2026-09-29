import { LeaderboardConfig } from '@prisma/client';
import { applyCampaignCap, deliveryAwards, type Award } from './points-rules';

// A minimal config with just the fields the rules read.
const CONFIG = {
  ptsDeliveryCompleted: 50,
  ptsOnTime: 20,
  ptsQualityClean: 15,
  overBase: 30,
  overCapRatio: 3,
  multCreationHundredths: 150,
  multDistributionHundredths: 100,
  perCampaignPointCap: 150,
} as unknown as LeaderboardConfig;

const pts = (a: Award[], t: string) => a.find((x) => x.type === t)?.points;

describe('leaderboard points rules', () => {
  describe('deliveryAwards', () => {
    it('full on-time distribution delivery: completed + on-time + clean, no over-delivery', () => {
      const a = deliveryAwards(CONFIG, { verified: 1000, promised: 1000, onTime: true, autoFlag: false, isCreation: false });
      expect(pts(a, 'DELIVERY_COMPLETED')).toBe(50);
      expect(pts(a, 'DELIVERED_ON_TIME')).toBe(20);
      expect(pts(a, 'QUALITY_CLEAN')).toBe(15);
      expect(pts(a, 'OVER_DELIVERY')).toBeUndefined();
    });

    it('over-delivery scales with the ratio to promise (2x → +30)', () => {
      const a = deliveryAwards(CONFIG, { verified: 2000, promised: 1000, onTime: true, autoFlag: false, isCreation: false });
      expect(pts(a, 'OVER_DELIVERY')).toBe(30);
    });

    it('over-delivery is capped at overCapRatio (5x clamped to 3x → +60)', () => {
      const a = deliveryAwards(CONFIG, { verified: 5000, promised: 1000, onTime: true, autoFlag: false, isCreation: false });
      expect(pts(a, 'OVER_DELIVERY')).toBe(60); // 30 × (3 − 1)
    });

    it('creation work applies the difficulty multiplier to effort awards', () => {
      const a = deliveryAwards(CONFIG, { verified: 2000, promised: 1000, onTime: true, autoFlag: false, isCreation: true });
      expect(pts(a, 'DELIVERY_COMPLETED')).toBe(75); // 50 × 1.5
      expect(pts(a, 'OVER_DELIVERY')).toBe(45); // 30 × 1.5
      expect(pts(a, 'DELIVERED_ON_TIME')).toBe(20); // behaviour bonus, not scaled
    });

    it('no on-time bonus when late; no clean bonus when flagged', () => {
      const a = deliveryAwards(CONFIG, { verified: 1000, promised: 1000, onTime: false, autoFlag: true, isCreation: false });
      expect(pts(a, 'DELIVERED_ON_TIME')).toBeUndefined();
      expect(pts(a, 'QUALITY_CLEAN')).toBeUndefined();
      expect(pts(a, 'DELIVERY_COMPLETED')).toBe(50);
    });
  });

  describe('applyCampaignCap', () => {
    it('trims the total so the campaign never exceeds the cap', () => {
      const awards: Award[] = [{ type: 'DELIVERY_COMPLETED', points: 50 }, { type: 'OVER_DELIVERY', points: 60 }];
      const kept = applyCampaignCap(awards, 140, 150); // only 10 of room left
      expect(kept).toEqual([{ type: 'DELIVERY_COMPLETED', points: 10 }]);
    });

    it('keeps everything when under the cap', () => {
      const awards: Award[] = [{ type: 'DELIVERY_COMPLETED', points: 50 }];
      expect(applyCampaignCap(awards, 0, 150)).toEqual(awards);
    });

    it('cap of 0 means uncapped', () => {
      const awards: Award[] = [{ type: 'OVER_DELIVERY', points: 9999 }];
      expect(applyCampaignCap(awards, 500, 0)).toEqual(awards);
    });
  });
});
