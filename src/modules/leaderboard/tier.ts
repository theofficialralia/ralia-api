import { LeaderboardConfig, PromoterTier } from '@prisma/client';

/**
 * A promoter's tier (docs/LEADERBOARD.md §9). Keyed on the STABLE metric — rolling-90
 * points — plus a reliability floor for the top tiers, so a tier reflects *sustained,
 * trustworthy* performance rather than a one-week spike or seniority. Because rolling-90
 * shrinks as activity ages out, an inactive promoter naturally decays down tiers when
 * the scheduler re-runs.
 */
export function tierFor(rolling90Points: number, reliability: number, config: LeaderboardConfig): PromoterTier {
  const floor = config.tierReliabilityFloor.toNumber();
  if (rolling90Points >= config.tierPlatinumAt && reliability >= floor) return 'PLATINUM';
  if (rolling90Points >= config.tierGoldAt && reliability >= floor) return 'GOLD';
  if (rolling90Points >= config.tierSilverAt) return 'SILVER';
  return 'BRONZE';
}

/** Tiers at or above `min`, for the matching eligibility gate (Campaign.minTier). */
export function tiersAtOrAbove(min: PromoterTier): PromoterTier[] {
  const order: PromoterTier[] = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'];
  return order.slice(order.indexOf(min));
}
