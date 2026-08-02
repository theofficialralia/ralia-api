/**
 * Deterministic promoter scoring — docs/ALGORITHMS.md §3–§8.
 *
 * These are the pure primitives the matching and allocation engines rank on:
 * trust evolution, reliability, fatigue, per-role capability, the two audience-fit
 * terms (reach / category), the composite match score, the hard filter, and the
 * supply-adaptive newbie gate + over-offer sizing.
 *
 * Unlike pricing, scores are dimensionless reputation signals, not money — plain
 * floats are fine. Everything here is pure and config-driven so the weights are
 * tunable knobs (they will later be sourced from rate_config) and every rule is
 * unit- and property-testable in isolation, with no database in the loop.
 *
 * Conventions: trust and capability live on a 0–100 scale (as stored and shown to
 * promoters); reliability, fatigue, reachFit, categoryFit and the final matchScore
 * are normalised to 0–1.
 */

export type PromoterRole = 'DISTRIBUTOR' | 'CREATOR' | 'PARTICIPATOR';

/** Reputation-affecting outcomes of a delivery, in the order they fire post-review. */
export type TrustEvent = 'ON_TIME_DELIVERY' | 'LATE_DELIVERY' | 'REJECTED' | 'NO_SHOW';

export type ScoringConfig = {
  /** Asymmetric trust deltas — reputation earned slowly, lost quickly (§4). */
  trust: {
    onTime: number;
    late: number;
    rejected: number;
    noShow: number;
    min: number;
    max: number;
  };
  /** Reliability blend (§5): recent delivery vs lifetime loyalty; no history → noHistory. */
  reliability: { rollingWeight: number; lifetimeWeight: number; noHistory: number };
  /** Match-score term weights (§7). capability & trust are divided by 100 in the sum. */
  rank: {
    capability: number;
    trust: number;
    reliability: number;
    reachFit: number;
    categoryFit: number;
    fatigue: number;
  };
  /** Hard-filter floors (§7): trust ≥ 30, capability ≥ floor. */
  trustFloor: number;
  capabilityFloor: number;
  /** Supply-adaptive newbie gate (§7): gate unproven promoters once supply ≥ ratio×slots. */
  newbieSupplyRatio: number;
  /** A promoter is "proven" (exempt from the gate) at either bar. */
  provenMinCompleted: number;
  provenTrust: number;
  /** Over-offer multiple of remaining slots (§8). */
  overOfferFactor: number;
  /** Absolute reach anchor for the provisional distributor capability factor (§3). */
  capabilityReachReference: number;
};

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  trust: { onTime: 2, late: 0.5, rejected: -6, noShow: -10, min: 0, max: 100 },
  reliability: { rollingWeight: 0.6, lifetimeWeight: 0.4, noHistory: 0.5 },
  rank: { capability: 0.2, trust: 0.2, reliability: 0.15, reachFit: 0.25, categoryFit: 0.2, fatigue: 0.15 },
  trustFloor: 30,
  capabilityFloor: 40,
  newbieSupplyRatio: 3,
  provenMinCompleted: 1,
  provenTrust: 55,
  overOfferFactor: 1.5,
  capabilityReachReference: 3000,
};

/** Per-role capability compositions (§3) — weights sum to 1.0, output scales to 0–100. */
export const CAPABILITY_WEIGHTS: Record<PromoterRole, Record<string, number>> = {
  DISTRIBUTOR: { verifiedReach: 0.5, postingFrequency: 0.2, recentPostProof: 0.3 },
  CREATOR: { ratedSamples: 0.5, contentBreadth: 0.15, equipment: 0.15, cameraComfort: 0.1, turnaround: 0.1 },
  PARTICIPATOR: { taskBreadth: 0.3, deviceCoverage: 0.3, multiStepWillingness: 0.2, agedAccounts: 0.2 },
};

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const clamp01 = (x: number): number => clamp(x, 0, 1);

/**
 * Applies one delivery outcome to a promoter's trust score and clamps to [0,100].
 * Asymmetric by construction: a rejection (−6) or no-show (−10) erases many
 * on-time deliveries (+2 each), so trust is expensive to rebuild.
 */
export function applyTrustEvent(
  current: number,
  event: TrustEvent,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): number {
  const { trust } = config;
  const delta =
    event === 'ON_TIME_DELIVERY'
      ? trust.onTime
      : event === 'LATE_DELIVERY'
        ? trust.late
        : event === 'REJECTED'
          ? trust.rejected
          : trust.noShow;
  return clamp(current + delta, trust.min, trust.max);
}

/**
 * Reliability (§5) = 0.6·rolling_ontime_rate(60d) + 0.4·lifetime_completion_rate.
 * With no history at all → 0.5 (neutral). When only one window has data, the other
 * substitutes it, so a loyal veteran isn't punished for a quiet recent month and a
 * fresh-but-active promoter isn't judged on an empty lifetime record.
 */
export function reliabilityScore(
  rollingOnTimeRate: number | null,
  lifetimeCompletionRate: number | null,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): number {
  const { reliability } = config;
  if (rollingOnTimeRate === null && lifetimeCompletionRate === null) return reliability.noHistory;
  const rolling = rollingOnTimeRate ?? lifetimeCompletionRate!;
  const lifetime = lifetimeCompletionRate ?? rollingOnTimeRate!;
  return clamp01(reliability.rollingWeight * clamp01(rolling) + reliability.lifetimeWeight * clamp01(lifetime));
}

/**
 * Fatigue (§6) = min(active_campaigns_7d / max_campaigns_per_week, 1), relative to
 * the promoter's own stated weekly cap. A promoter with no capacity stated (cap ≤ 0)
 * is treated as fully fatigued — conservative, keeps them out of the rank until set.
 */
export function fatigueScore(activeCampaigns7d: number, maxCampaignsPerWeek: number): number {
  if (maxCampaignsPerWeek <= 0) return 1;
  return clamp01(activeCampaigns7d / maxCampaignsPerWeek);
}

/**
 * Per-role capability (§3), 0–100. `factors` are normalised 0–1 inputs keyed by the
 * role's composition; a missing factor counts as 0 (not yet demonstrated). Verified
 * inputs are expected to dominate via their weights, and the whole score is meant to
 * be admin-confirmable at the "under review" step.
 */
export function capabilityScore(
  role: PromoterRole,
  factors: Record<string, number>,
  weights: Record<PromoterRole, Record<string, number>> = CAPABILITY_WEIGHTS,
): number {
  const w = weights[role];
  if (!w) throw new Error(`No capability composition for role ${role}`);
  let sum = 0;
  for (const [key, weight] of Object.entries(w)) sum += weight * clamp01(factors[key] ?? 0);
  return Math.round(clamp01(sum) * 100);
}

/**
 * reachFit (§7) — "right-sized", not "largest". 1.0 when the promoter's reach equals
 * the slot's remaining need, decaying symmetrically as they under- or over-shoot, so
 * a 50k-follower account doesn't win a slot that needs 2k. Ratio of the smaller to the
 * larger of {reach, need}.
 */
export function reachFit(candidateReach: number, slotNeed: number): number {
  if (slotNeed <= 0 || candidateReach <= 0) return 0;
  return clamp01(candidateReach <= slotNeed ? candidateReach / slotNeed : slotNeed / candidateReach);
}

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * categoryFit (§7) — the fraction of the campaign's targeted categories the promoter
 * covers. An untargeted campaign (no categories) fits everyone (1.0); a targeted one
 * with no overlap scores 0.
 */
export function categoryFit(promoterCategories: string[], campaignCategories: string[]): number {
  if (campaignCategories.length === 0) return 1;
  if (promoterCategories.length === 0) return 0;
  const have = new Set(promoterCategories.map(norm));
  const hits = campaignCategories.filter((c) => have.has(norm(c))).length;
  return hits / campaignCategories.length;
}

export type MatchInputs = {
  /** 0–100 */
  capability: number;
  /** 0–100 */
  trust: number;
  /** 0–1 */
  reliability: number;
  /** 0–1 */
  reachFit: number;
  /** 0–1 */
  categoryFit: number;
  /** 0–1 */
  fatigue: number;
};

/**
 * Performance-weighted match score (§7): proven signals 55% (capability, trust,
 * reliability) / audience fit 45% (reachFit, categoryFit), minus a fatigue penalty.
 * capability and trust are normalised /100 inside the sum. Result is clamped to
 * [0,1] and surfaced to promoters as a per-offer "Fit %".
 */
export function matchScore(i: MatchInputs, config: ScoringConfig = DEFAULT_SCORING_CONFIG): number {
  const w = config.rank;
  const s =
    w.capability * (clamp(i.capability, 0, 100) / 100) +
    w.trust * (clamp(i.trust, 0, 100) / 100) +
    w.reliability * clamp01(i.reliability) +
    w.reachFit * clamp01(i.reachFit) +
    w.categoryFit * clamp01(i.categoryFit) -
    w.fatigue * clamp01(i.fatigue);
  return clamp01(s);
}

export type HardFilterInput = {
  roleEligible: boolean;
  platformMatch: boolean;
  status: string;
  trust: number;
  capability: number;
};

/**
 * Hard filter (§7) — a candidate must clear every gate to be ranked at all:
 * role-eligible, platform match, ACTIVE, trust ≥ floor, capability ≥ floor.
 * (Geo/age/language are applied upstream by the query and passed in via roleEligible.)
 */
export function passesHardFilter(i: HardFilterInput, config: ScoringConfig = DEFAULT_SCORING_CONFIG): boolean {
  return (
    i.roleEligible &&
    i.platformMatch &&
    i.status === 'ACTIVE' &&
    i.trust >= config.trustFloor &&
    i.capability >= config.capabilityFloor
  );
}

/**
 * A promoter is "proven" (exempt from the newbie gate) once they have completed at
 * least `provenMinCompleted` deliveries OR carry trust ≥ `provenTrust`.
 */
export function isProven(
  completedDeliveries: number,
  trust: number,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): boolean {
  return completedDeliveries >= config.provenMinCompleted || trust >= config.provenTrust;
}

/**
 * Supply-adaptive newbie gate (§7), decided per-campaign at match time. When qualified
 * supply is abundant (≥ ratio× the slots left) we can afford to gate unproven promoters
 * out; when supply is tight we open access to everyone eligible. `slotsRemaining ≤ 0`
 * means nothing to fill → gate hard.
 */
export function newbieGateActive(
  eligibleQualified: number,
  slotsRemaining: number,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): boolean {
  if (slotsRemaining <= 0) return true;
  return eligibleQualified / slotsRemaining >= config.newbieSupplyRatio;
}

/**
 * Over-offer sizing (§8): to fill N slots we extend ~1.5×N offers, expecting some to
 * lapse. Atomic slot locking (in the allocation service) prevents the surplus from
 * over-filling. Never over-offers when there is nothing left to fill.
 */
export function overOfferCount(slotsRemaining: number, config: ScoringConfig = DEFAULT_SCORING_CONFIG): number {
  if (slotsRemaining <= 0) return 0;
  return Math.ceil(slotsRemaining * config.overOfferFactor);
}

/**
 * Human-readable capability band for the 0–100 score — surfaced to promoters and
 * admins alongside the raw number so a "do X to raise it" nudge has a label to move.
 */
export function capabilityTier(score: number): string {
  if (score >= 80) return 'Elite';
  if (score >= 60) return 'Established';
  if (score >= 40) return 'Developing';
  return 'Emerging';
}
