import { CampaignObjective } from '@prisma/client';
import {
  activeFilterCount,
  PricingConfig,
  slotPriceMinor,
  splitFee,
  targetingMultHundredths,
  TargetingFilters,
} from './pricing';

/**
 * §5.2, every expected value worked by hand from the handoff, never from the
 * implementation.
 *
 *   slot_price = (effective_reach / 1000) × RPM × objective_mult × targeting_mult
 *   RPM = 3000 kobo | take_rate = 0.30
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
  takeRateHundredths: 30,
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
    it('promoter keeps 70%, Ralia takes 30%', () => {
      const { promoterFeeMinor, raliaTakeMinor } = splitFee(3000n, CONFIG);
      expect(promoterFeeMinor).toBe(2100n);
      expect(raliaTakeMinor).toBe(900n);
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
      // 4501 × 0.7 = 3150.7 → 3151; take = 4501 − 3151 = 1350
      const { promoterFeeMinor, raliaTakeMinor } = splitFee(4501n, CONFIG);
      expect(promoterFeeMinor).toBe(3151n);
      expect(raliaTakeMinor).toBe(1350n);
      expect(promoterFeeMinor + raliaTakeMinor).toBe(4501n);
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
});
