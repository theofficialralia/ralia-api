import { Platform, VerificationTier } from '@prisma/client';

/**
 * Effective reach — handoff §5.1. Flat, non-learning.
 *
 *   effective_reach = round(claimed_audience × platform_factor × verification_factor)
 *
 * There is deliberately no delivery-feedback loop; that is Phase 2 (§11).
 * Computed server-side on every save. Never accept this value from a client.
 */

export type ReachFactors = {
  platform: Record<Platform, number>;
  tier: Record<VerificationTier, number>;
};

/** Defaults from §5.1. The active rate_config row is the runtime source of truth. */
export const DEFAULT_REACH_FACTORS: ReachFactors = {
  platform: {
    WHATSAPP_STATUS: 0.3,
    WHATSAPP_GROUP: 0.2,
    TELEGRAM: 0.2,
    INSTAGRAM: 0.1,
    FACEBOOK: 0.1,
    TIKTOK: 0.12,
    X: 0.05,
    LINKEDIN: 0.12,
    OFFLINE: 0.15,
  },
  tier: {
    SELF: 0.6,
    SCREENSHOT: 1.0,
    INSIGHTS: 1.15,
  },
};

export function computeEffectiveReach(
  claimedAudience: number,
  platform: Platform,
  tier: VerificationTier,
  factors: ReachFactors = DEFAULT_REACH_FACTORS,
): number {
  if (!Number.isFinite(claimedAudience) || claimedAudience < 0) {
    throw new Error(`claimedAudience must be a non-negative finite number, got ${claimedAudience}`);
  }
  const platformFactor = factors.platform[platform];
  const tierFactor = factors.tier[tier];
  if (platformFactor === undefined) throw new Error(`No platform factor for ${platform}`);
  if (tierFactor === undefined) throw new Error(`No verification factor for ${tier}`);

  return Math.round(claimedAudience * platformFactor * tierFactor);
}
