import { CampaignObjective } from '@prisma/client';
import {
  activeFilterCount,
  PricingConfig,
  settleDelivery,
  SettlementConfig,
  slotPriceMinor,
  slotTargetReach,
  splitFee,
  targetingMultHundredths,
  TargetingFilters,
} from './pricing';

/**
 * §5.2, every expected value worked by hand from the handoff, never from the
 * implementation.
 *
 *   slot_price = (effective_reach / 1000) × RPM × objective_mult × targeting_mult
 *   RPM = 3000 kobo | take_rate = 0.50
 */
const CONFIG: PricingConfig = {
  rpmMinor: 3000,
  objectiveMultHundredths: {
    [CampaignObjective.AWARENESS]: 100,
    [CampaignObjective.WEBSITE_VISIT]: 110,
    [CampaignObjective.APP_INSTALL]: 125,
    [CampaignObjective.LEAD_GEN]: 140,
    [CampaignObjective.PURCHASE]: 150,
  },
  targetingStepHundredths: 5,
  targetingCapHundredths: 135,
  takeRateHundredths: 50,
};

const NO_FILTERS: TargetingFilters = {
  states: [], lgas: [], ageMin: null, ageMax: null, genders: [],
  languages: [], categories: [], platforms: [], minEffectiveReach: 0, roles: [],
};

describe('pricing (§5.2)', () => {
  describe('slot price', () => {
    it('awareness, 1000 reach, no filters → ₦30 (3000 kobo)', () => {
      // (1000/1000) × 3000 × 1.0 × 1.0 = 3000
      expect(slotPriceMinor(1000, CampaignObjective.AWARENESS, NO_FILTERS, CONFIG)).toBe(3000n);
    });

    it('purchase, 1000 reach, no filters → 4500 kobo', () => {
      // 1 × 3000 × 1.5 × 1.0 = 4500
      expect(slotPriceMinor(1000, CampaignObjective.PURCHASE, NO_FILTERS, CONFIG)).toBe(4500n);
    });

    it('scales linearly with reach: 5000 reach awareness → 15000 kobo', () => {
      // 5 × 3000 × 1.0 = 15000
      expect(slotPriceMinor(5000, CampaignObjective.AWARENESS, NO_FILTERS, CONFIG)).toBe(15000n);
    });

    it('applies the targeting multiplier: lead_gen, 2000 reach, 3 filters', () => {
      // targeting_mult = 1 + 0.05×3 = 1.15
      // (2000/1000) × 3000 × 1.4 × 1.15 = 2 × 3000 × 1.4 × 1.15 = 9660
      const filters: TargetingFilters = {
        ...NO_FILTERS, states: ['Lagos'], categories: ['Fashion'], platforms: ['INSTAGRAM'],
      };
      expect(activeFilterCount(filters)).toBe(3);
      expect(slotPriceMinor(2000, CampaignObjective.LEAD_GEN, filters, CONFIG)).toBe(9660n);
    });

    it('caps the targeting multiplier at 1.35', () => {
      // 9 active filters → 1 + 0.45 = 1.45, capped to 1.35
      const all: TargetingFilters = {
        states: ['Lagos'], lgas: ['Ikeja'], ageMin: 18, ageMax: 45, genders: ['MALE'],
        languages: ['English'], categories: ['Tech'], platforms: ['X'], minEffectiveReach: 100,
        roles: ['DISTRIBUTOR'],
      };
      expect(activeFilterCount(all)).toBe(9);
      expect(targetingMultHundredths(9, CONFIG)).toBe(135);
      // (1000/1000) × 3000 × 1.0 × 1.35 = 4050
      expect(slotPriceMinor(1000, CampaignObjective.AWARENESS, all, CONFIG)).toBe(4050n);
    });

    it('rounds half up, never truncating money', () => {
      // 333 reach, awareness: (333/1000)×3000 = 999 exactly — pick a fractional case:
      // 111 reach × 3000 / 1000 = 333; use website (1.1): 333 × 1.1 = 366.3 → 366
      expect(slotPriceMinor(111, CampaignObjective.WEBSITE_VISIT, NO_FILTERS, CONFIG)).toBe(366n);
    });

    it('zero reach is zero price', () => {
      expect(slotPriceMinor(0, CampaignObjective.PURCHASE, NO_FILTERS, CONFIG)).toBe(0n);
    });

    it('rejects a negative or non-integer reach', () => {
      expect(() => slotPriceMinor(-1, CampaignObjective.AWARENESS, NO_FILTERS, CONFIG)).toThrow();
      expect(() => slotPriceMinor(1.5, CampaignObjective.AWARENESS, NO_FILTERS, CONFIG)).toThrow();
    });
  });

  describe('fee split', () => {
    it('promoter keeps 50%, Ralia takes 50%', () => {
      const { promoterFeeMinor, raliaTakeMinor } = splitFee(3000n, CONFIG);
      expect(promoterFeeMinor).toBe(1500n);
      expect(raliaTakeMinor).toBe(1500n);
    });

    it('fee + take is exactly the slot price, for every price up to 100k kobo', () => {
      // The ledger's approve posting debits escrow by the full slot price and
      // credits fee + take. If these ever disagreed by a kobo, escrow would leak.
      for (let price = 0n; price <= 100_000n; price += 7n) {
        const { promoterFeeMinor, raliaTakeMinor } = splitFee(price, CONFIG);
        expect(promoterFeeMinor + raliaTakeMinor).toBe(price);
        expect(promoterFeeMinor).toBeGreaterThanOrEqual(0n);
        expect(raliaTakeMinor).toBeGreaterThanOrEqual(0n);
      }
    });

    it('handles an odd price without losing a kobo', () => {
      // 4501 × 0.5 = 2250.5 → 2251; take = 4501 − 2251 = 2250
      const { promoterFeeMinor, raliaTakeMinor } = splitFee(4501n, CONFIG);
      expect(promoterFeeMinor).toBe(2251n);
      expect(raliaTakeMinor).toBe(2250n);
      expect(promoterFeeMinor + raliaTakeMinor).toBe(4501n);
    });
  });

  describe('pro-rata settlement (§2)', () => {
    // gross 3000 kobo (awareness, 1000 reach), τ = 70%, take 50%.
    const SETTLE: SettlementConfig = { takeRateHundredths: 50, deliveryThresholdPct: 70 };

    it('full delivery pays the whole fee, refunds nothing', () => {
      const s = settleDelivery(3000n, 1000, 1000, SETTLE);
      expect(s.meetsThreshold).toBe(true);
      expect(s.deliveredGrossMinor).toBe(3000n);
      expect(s.promoterFeeMinor).toBe(1500n);
      expect(s.raliaTakeMinor).toBe(1500n);
      expect(s.refundMinor).toBe(0n);
    });

    it('over-delivery is capped at 100% — the fee is a ceiling', () => {
      const s = settleDelivery(3000n, 1500, 1000, SETTLE);
      expect(s.deliveredGrossMinor).toBe(3000n);
      expect(s.refundMinor).toBe(0n);
      expect(s.meetsThreshold).toBe(true);
    });

    it('partial delivery above the threshold pays pro-rata and refunds the delta', () => {
      // 800/1000 ≥ 70% → paid. delivered_gross = 3000×800/1000 = 2400.
      const s = settleDelivery(3000n, 800, 1000, SETTLE);
      expect(s.meetsThreshold).toBe(true);
      expect(s.deliveredGrossMinor).toBe(2400n);
      expect(s.promoterFeeMinor).toBe(1200n); // 2400 × 0.5
      expect(s.raliaTakeMinor).toBe(1200n);
      expect(s.refundMinor).toBe(600n); // 3000 − 2400
    });

    it('the threshold boundary is inclusive (verified = τ × promised)', () => {
      expect(settleDelivery(3000n, 700, 1000, SETTLE).meetsThreshold).toBe(true);
      expect(settleDelivery(3000n, 699, 1000, SETTLE).meetsThreshold).toBe(false);
    });

    it('below the threshold does not meet it (caller rejects)', () => {
      const s = settleDelivery(3000n, 600, 1000, SETTLE);
      expect(s.meetsThreshold).toBe(false);
    });

    it('zero delivery meets nothing and refunds the whole slot', () => {
      const s = settleDelivery(3000n, 0, 1000, SETTLE);
      expect(s.meetsThreshold).toBe(false);
      expect(s.deliveredGrossMinor).toBe(0n);
      expect(s.promoterFeeMinor).toBe(0n);
      expect(s.refundMinor).toBe(3000n);
    });

    it('rounds without losing a kobo (odd gross, odd ratio)', () => {
      // delivered_gross = round(4501 × 777 / 1000) = round(3497.277) = 3497
      // fee = round(3497 × 0.5) = round(1748.5) = 1749, take = 1748, refund = 4501 − 3497 = 1004
      const s = settleDelivery(4501n, 777, 1000, SETTLE);
      expect(s.deliveredGrossMinor).toBe(3497n);
      expect(s.promoterFeeMinor).toBe(1749n);
      expect(s.raliaTakeMinor).toBe(1748n);
      expect(s.refundMinor).toBe(1004n);
    });

    it('fee + take + refund equals gross exactly, so escrow never leaks', () => {
      // The approve posting debits escrow by delivered_gross and refunds the rest;
      // a one-kobo disagreement anywhere would strand money in escrow.
      for (let gross = 0n; gross <= 20_000n; gross += 137n) {
        for (const [verified, promised] of [[0, 1000], [1, 1000], [499, 1000], [700, 1000], [999, 1000], [1000, 1000], [5000, 5000], [3333, 5000]] as const) {
          const s = settleDelivery(gross, verified, promised, SETTLE);
          expect(s.promoterFeeMinor + s.raliaTakeMinor).toBe(s.deliveredGrossMinor);
          expect(s.deliveredGrossMinor + s.refundMinor).toBe(gross);
          expect(s.deliveredGrossMinor).toBeGreaterThanOrEqual(0n);
          expect(s.deliveredGrossMinor).toBeLessThanOrEqual(gross);
          expect(s.refundMinor).toBeGreaterThanOrEqual(0n);
        }
      }
    });

    it('rejects a non-positive promised reach and a negative verified reach', () => {
      expect(() => settleDelivery(3000n, 500, 0, SETTLE)).toThrow();
      expect(() => settleDelivery(3000n, -1, 1000, SETTLE)).toThrow();
    });
  });

  describe('active filter count', () => {
    it('counts each set dimension once; age range counts once', () => {
      expect(activeFilterCount(NO_FILTERS)).toBe(0);
      expect(activeFilterCount({ ...NO_FILTERS, ageMin: 18 })).toBe(1);
      expect(activeFilterCount({ ...NO_FILTERS, ageMin: 18, ageMax: 45 })).toBe(1);
      expect(activeFilterCount({ ...NO_FILTERS, states: ['Lagos'], minEffectiveReach: 100 })).toBe(2);
    });
  });

  describe('slot target reach (inverse of slot price)', () => {
    it('recovers the reach a slot price was computed from', () => {
      // slotPrice(2000, AWARENESS) = 6000 → slotTargetReach(6000) = 2000.
      const price = slotPriceMinor(2000, CampaignObjective.AWARENESS, NO_FILTERS, CONFIG);
      expect(slotTargetReach(price, CampaignObjective.AWARENESS, NO_FILTERS, CONFIG)).toBe(2000);
    });

    it('round-trips across objectives and filters', () => {
      const filters: TargetingFilters = { ...NO_FILTERS, states: ['Lagos'], ageMin: 18, ageMax: 40 };
      for (const reach of [500, 1000, 3450, 12000]) {
        const price = slotPriceMinor(reach, CampaignObjective.LEAD_GEN, filters, CONFIG);
        // Exact within rounding — the forward price rounds once, so the inverse is ±1.
        expect(Math.abs(slotTargetReach(price, CampaignObjective.LEAD_GEN, filters, CONFIG) - reach)).toBeLessThanOrEqual(1);
      }
    });
  });
});
