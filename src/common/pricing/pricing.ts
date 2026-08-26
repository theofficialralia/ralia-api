import { CampaignObjective, PromoterRole } from '@prisma/client';

/**
 * A campaign's pricing category — the product owner's two governing tiers.
 * Distribution is priced for raw reach; Creation/Participation is priced for the
 * work of making content. Each carries its own RPM, minimum campaign floor, and
 * default reach/promoter counts (all in rate_config).
 */
export type CampaignCategory = 'DISTRIBUTION' | 'CREATION';

/**
 * Which category a slot's role belongs to. CREATOR and PARTICIPATOR are the
 * "Creation/Participation" tier; DISTRIBUTOR and INFLUENCER are reach-driven, so
 * they price as Distribution.
 */
export function categoryForRole(role: PromoterRole): CampaignCategory {
  return role === PromoterRole.CREATOR || role === PromoterRole.PARTICIPATOR
    ? 'CREATION'
    : 'DISTRIBUTION';
}

/**
 * Deterministic pricing — handoff §5.2.
 *
 *   slot_price   = (effective_reach / 1000) × RPM × objective_mult × targeting_mult
 *   RPM          = kobo per 1000 views, chosen per campaign category — Distribution
 *                  vs Creation (config; see RateConfigService.getPricingConfig)
 *   targeting_mult = 1 + step × (active filter count), capped
 *   promoter_fee = slot_price × (1 − take_rate)     take_rate = 0.50 (config, 50/50 split)
 *   campaign_price = Σ slot_price, and must clear the category's minimum floor
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
  config: Pick<PricingConfig, 'takeRateHundredths'>,
): { promoterFeeMinor: bigint; raliaTakeMinor: bigint } {
  const keepHundredths = BigInt(100 - config.takeRateHundredths);
  const promoterFeeMinor = divRound(slotPriceMinor * keepHundredths, 100n);
  const raliaTakeMinor = slotPriceMinor - promoterFeeMinor;
  return { promoterFeeMinor, raliaTakeMinor };
}

/**
 * Pro-rata settlement of one delivered slot — ALGORITHMS.md §2.
 *
 *   delivered_ratio = min(verified, promised) / promised          (over-delivery capped at 100%)
 *   meets_threshold = verified ≥ τ × promised                     (below τ → reject, do not pay)
 *   delivered_gross = round(gross × min(verified, promised) / promised)
 *   fee             = splitFee(delivered_gross).fee               (promoter, pro-rata)
 *   take            = gross − fee                                 (Ralia's cut + any undelivered remainder)
 *
 * fee + take = gross exactly, so escrow conserves. There is NO client refund:
 * the platform has no client wallet, so an under-delivery is not returned — the
 * promoter is paid for what they delivered and Ralia retains the remainder.
 * Integer kobo throughout; `promised` must be positive (a zero-reach promoter is
 * never offered).
 */
export type SettlementConfig = {
  takeRateHundredths: number;
  /** τ as a whole percent: a delivery below this share of promised is rejected. */
  deliveryThresholdPct: number;
};

export type Settlement = {
  meetsThreshold: boolean;
  deliveredGrossMinor: bigint;
  promoterFeeMinor: bigint;
  raliaTakeMinor: bigint;
};

export function settleDelivery(
  grossMinor: bigint,
  verifiedReach: number,
  promisedReach: number,
  config: SettlementConfig,
): Settlement {
  if (!Number.isInteger(promisedReach) || promisedReach <= 0) {
    throw new Error(`promisedReach must be a positive integer, got ${promisedReach}`);
  }
  if (!Number.isInteger(verifiedReach) || verifiedReach < 0) {
    throw new Error(`verifiedReach must be a non-negative integer, got ${verifiedReach}`);
  }
  if (grossMinor < 0n) throw new Error(`grossMinor must be non-negative, got ${grossMinor}`);

  // Integer-only threshold: verified/promised ≥ τ/100  ⇔  verified×100 ≥ τ×promised.
  const meetsThreshold = verifiedReach * 100 >= config.deliveryThresholdPct * promisedReach;

  // Over-delivery is capped at the promised amount — the fee is a ceiling.
  const effective = Math.min(verifiedReach, promisedReach);
  const deliveredGrossMinor = divRound(grossMinor * BigInt(effective), BigInt(promisedReach));
  // Promoter is paid pro-rata on what they delivered; Ralia keeps the rest of the
  // slot gross (its take on the delivered portion PLUS any undelivered remainder).
  // No client refund — there is no client wallet to return it to.
  const { promoterFeeMinor } = splitFee(deliveredGrossMinor, config);
  const raliaTakeMinor = grossMinor - promoterFeeMinor;

  return { meetsThreshold, deliveredGrossMinor, promoterFeeMinor, raliaTakeMinor };
}

/**
 * The effective reach a slot was priced around — the inverse of {@link slotPriceMinor}.
 * Since `slot_price = round(reach × rpm × objMult × tgtMult / 10^7)`, the reach the
 * slot's `unitPriceMinor` was budgeted for is `price × 10^7 / (rpm × objMult × tgtMult)`.
 * Matching uses this as the "right-sized" target for reachFit (ALGORITHMS.md §7) so a
 * candidate is judged against what the slot actually needs, not the biggest audience.
 */
export function slotTargetReach(
  unitPriceMinor: bigint,
  objective: CampaignObjective,
  filters: TargetingFilters,
  config: PricingConfig,
): number {
  const objMult = config.objectiveMultHundredths[objective];
  if (objMult === undefined) throw new Error(`No objective multiplier for ${objective}`);
  const tgtMult = targetingMultHundredths(activeFilterCount(filters), config);
  const denom = BigInt(config.rpmMinor) * BigInt(objMult) * BigInt(tgtMult);
  if (denom === 0n) return 0;
  return Number(divRound(unitPriceMinor * 10_000_000n, denom));
}

export function objectiveMultLabel(objective: CampaignObjective): string {
  return objective.toLowerCase();
}

/**
 * Price-driven sizing (governing logic #2, the inverse of the quote formula).
 *
 * The client names an EXACT campaign price; we derive the total reach it buys and
 * the whole number of promoter slots that spreads across, at the category's
 * reach-per-slot. The price is authoritative and is NEVER snapped — only the
 * promoter count rounds (you can't book 4.3 promoters). This is what keeps the
 * quote equal to what the client typed, and it reproduces the category floors
 * exactly: ₦15,000 Distribution → 5,000 reach ÷ 1,000 = 5 promoters; ₦100,000
 * Creation → 200,000 reach ÷ 10,000 = 20 promoters.
 *
 *   total_reach = slotTargetReach(price)                      // reach-postings the price buys
 *   slots       = max(1, round(total_reach ÷ reachPerSlotAllPosts))
 *
 * `reachPerSlotAllPosts` is reach_per_slot × posts_required — one promoter slot
 * delivers reach_per_slot per post across all its posts.
 */
export function sizeFromPrice(
  totalPriceMinor: bigint,
  objective: CampaignObjective,
  filters: TargetingFilters,
  reachPerSlotAllPosts: number,
  config: PricingConfig,
): { totalReach: number; slots: number } {
  const totalReach = slotTargetReach(totalPriceMinor, objective, filters, config);
  const basis = Math.max(1, reachPerSlotAllPosts);
  const slots = Math.max(1, Math.round(totalReach / basis));
  return { totalReach, slots };
}

/**
 * Splits an exact campaign price across N promoter slots × posts so the per-post
 * unit prices sum back to the price with NO drift — the first `remainder` postings
 * carry one extra kobo. Escrow holds exactly `totalPriceMinor`, and Σ(unit) equals
 * it, so ledger conservation holds even when the price doesn't divide evenly.
 */
export function perPostUnitPrices(totalPriceMinor: bigint, slots: number, posts: number): bigint[] {
  const units = BigInt(Math.max(1, slots)) * BigInt(Math.max(1, posts));
  const base = totalPriceMinor / units;
  const remainder = Number(totalPriceMinor - base * units);
  return Array.from({ length: Number(units) }, (_, i) => (i < remainder ? base + 1n : base));
}
