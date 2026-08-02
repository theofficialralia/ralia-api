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

// ─────────────────────────────────────────────────────────────
// Reach policy — ALGORITHMS.md §1 extensions over the flat §5.1 core.
// ─────────────────────────────────────────────────────────────

export type ChannelReachInput = {
  platform: Platform;
  claimedAudience: number;
  isGroup: boolean;
  activeParticipants: number | null;
  verificationTier: VerificationTier;
  /** When the current screenshot/insights proof was accepted; null if unproven. */
  verifiedAt: Date | null;
};

export type ReachPolicy = {
  factors: ReachFactors;
  /** Self-reported effective reach is capped here until a proof lifts it. */
  unverifiedReachCap: number;
  /** A screenshot/insights proof older than this many days decays to self-reported. */
  proofValidityDays: number;
};

/**
 * The verification tier that actually applies right now. A screenshot/insights
 * proof past its validity window decays to SELF, as does a verified tier with no
 * recorded proof timestamp — audiences drift, so an unrefreshed proof stops
 * earning its multiplier (ALGORITHMS.md §1).
 */
export function currentTier(
  tier: VerificationTier,
  verifiedAt: Date | null,
  proofValidityDays: number,
  now: Date,
): VerificationTier {
  if (tier === VerificationTier.SELF) return VerificationTier.SELF;
  if (!verifiedAt) return VerificationTier.SELF;
  const ageDays = (now.getTime() - verifiedAt.getTime()) / 86_400_000;
  return ageDays > proofValidityDays ? VerificationTier.SELF : tier;
}

/**
 * Effective reach used for matching and pricing (ALGORITHMS.md §1):
 *   - groups count active participants, not total members
 *   - a stale proof decays to self-reported (see currentTier)
 *   - self-reported reach is capped until a proof lifts it
 */
export function channelEffectiveReach(input: ChannelReachInput, policy: ReachPolicy, now: Date): number {
  const basis = input.isGroup ? input.activeParticipants ?? 0 : input.claimedAudience;
  const tier = currentTier(input.verificationTier, input.verifiedAt, policy.proofValidityDays, now);
  const reach = computeEffectiveReach(basis, input.platform, tier, policy.factors);
  return tier === VerificationTier.SELF ? Math.min(reach, policy.unverifiedReachCap) : reach;
}
