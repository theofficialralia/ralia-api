import { CampaignObjective } from '@prisma/client';

/**
 * Deterministic pricing — handoff §5.2.
 *
 *   slot_price   = (effective_reach / 1000) × RPM × objective_mult × targeting_mult
 *   RPM          = kobo per 1000 views (config)
 *   targeting_mult = 1 + step × (active filter count), capped
 *   promoter_fee = slot_price × (1 − take_rate)
 *   campaign_price = Σ slot_price
 *
 * Everything is integer kobo. The multipliers are Decimal(4,2) in rate_config,
 * so they are exact in hundredths; the whole computation runs in BigInt and
 * rounds exactly once. No float ever touches money.
 */

/** Multipliers arrive as hundredths (1.25 → 125) so the arithmetic stays integer. */
export type PricingConfig = {
  rpmMinor: number;
  objectiveMultHundredths: Record<CampaignObjective, number>;
  targetingStepHundredths: number;
  targetingCapHundredths: number;
  takeRateHundredths: number;
};

export type TargetingFilters = {
  states: string[];
  lgas: string[];
  ageMin: number | null;
  ageMax: number | null;
  genders: string[];
  languages: string[];
  categories: string[];
  platforms: string[];
  minEffectiveReach: number;
  roles: string[];
};

/**
 * How many targeting dimensions actually constrain the audience. Each non-empty
 * / non-default field is one active filter; the age range counts once whether
 * one or both bounds are set.
 */
export function activeFilterCount(t: TargetingFilters): number {
  let n = 0;
  if (t.states.length > 0) n++;
  if (t.lgas.length > 0) n++;
  if (t.ageMin !== null || t.ageMax !== null) n++;
  if (t.genders.length > 0) n++;
  if (t.languages.length > 0) n++;
  if (t.categories.length > 0) n++;
  if (t.platforms.length > 0) n++;
  if (t.minEffectiveReach > 0) n++;
  if (t.roles.length > 0) n++;
  return n;
}

/** targeting_mult in hundredths: 100 + step×count, capped. */
export function targetingMultHundredths(count: number, config: PricingConfig): number {
  const raw = 100 + config.targetingStepHundredths * count;
  return Math.min(raw, config.targetingCapHundredths);
}

/** Round-half-up division of BigInts. Both args positive. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

/**
 * One slot's price in kobo.
 *
 *   effective_reach × RPM × objMult_h × tgtMult_h
 *   ─────────────────────────────────────────────   (1000 views × 100 × 100)
 *              10,000,000
 */
export function slotPriceMinor(
  effectiveReach: number,
  objective: CampaignObjective,
  filters: TargetingFilters,
  config: PricingConfig,
): bigint {
  if (!Number.isInteger(effectiveReach) || effectiveReach < 0) {
    throw new Error(`effectiveReach must be a non-negative integer, got ${effectiveReach}`);
  }
  const objMult = config.objectiveMultHundredths[objective];
  if (objMult === undefined) throw new Error(`No objective multiplier for ${objective}`);

  const tgtMult = targetingMultHundredths(activeFilterCount(filters), config);

  const numerator =
    BigInt(effectiveReach) * BigInt(config.rpmMinor) * BigInt(objMult) * BigInt(tgtMult);
  return divRound(numerator, 10_000_000n);
}

/**
 * Splits a slot price into the promoter's fee and Ralia's take.
 *
 * take is derived by subtraction, never rounded independently, so fee + take is
 * exactly the slot price — the ledger's approve posting depends on that equality.
 */
export function splitFee(
  slotPriceMinor: bigint,
  config: PricingConfig,
): { promoterFeeMinor: bigint; raliaTakeMinor: bigint } {
  const keepHundredths = BigInt(100 - config.takeRateHundredths);
  const promoterFeeMinor = divRound(slotPriceMinor * keepHundredths, 100n);
  const raliaTakeMinor = slotPriceMinor - promoterFeeMinor;
  return { promoterFeeMinor, raliaTakeMinor };
}

export function objectiveMultLabel(objective: CampaignObjective): string {
  return objective.toLowerCase();
}
