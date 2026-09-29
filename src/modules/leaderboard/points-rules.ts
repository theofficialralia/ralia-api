import { LeaderboardConfig, PointEventType } from '@prisma/client';

export type Award = { type: PointEventType; points: number };

export type DeliveryPointInput = {
  /** Admin-verified views on the post. */
  verified: number;
  /** The reach the slot promised (its target). */
  promised: number;
  /** Delivered by its deadline. */
  onTime: boolean;
  /** The proof was auto-flagged as a possible duplicate. */
  autoFlag: boolean;
  /** Creation-category work is worth the difficulty multiplier. */
  isCreation: boolean;
};

/**
 * The points an approved submission earns (docs/LEADERBOARD.md §3/§4). Pure — the
 * caller applies the per-campaign cap and persists via PointsService. Difficulty scales
 * effort awards (completed + over-delivery); behaviour bonuses (on-time, clean) are flat.
 */
export function deliveryAwards(config: LeaderboardConfig, input: DeliveryPointInput): Award[] {
  const mult = input.isCreation ? config.multCreationHundredths : config.multDistributionHundredths;
  const scale = (p: number) => Math.round((p * mult) / 100);

  const out: Award[] = [{ type: 'DELIVERY_COMPLETED', points: scale(config.ptsDeliveryCompleted) }];

  if (input.onTime) out.push({ type: 'DELIVERED_ON_TIME', points: config.ptsOnTime });
  if (!input.autoFlag) out.push({ type: 'QUALITY_CLEAN', points: config.ptsQualityClean });

  // Over-delivery — reward the ratio to promise, clamped, so it's relative not absolute
  // (a small promoter over-performing scores like a big one). §4.
  if (input.promised > 0 && input.verified > input.promised) {
    const ratio = Math.min(input.verified / input.promised, config.overCapRatio);
    const over = Math.round(config.overBase * (ratio - 1));
    if (over > 0) out.push({ type: 'OVER_DELIVERY', points: scale(over) });
  }

  return out.filter((a) => a.points > 0);
}

/**
 * Trim a list of positive awards so the running campaign total never exceeds the cap.
 * `priorPositive` is what the promoter already earned on this campaign. Awards are kept
 * in order; the one that crosses the cap is clamped, the rest dropped.
 */
export function applyCampaignCap(awards: Award[], priorPositive: number, cap: number): Award[] {
  if (cap <= 0) return awards; // 0 = uncapped
  let running = Math.max(0, priorPositive);
  const kept: Award[] = [];
  for (const a of awards) {
    if (running >= cap) break;
    const room = cap - running;
    const points = Math.min(a.points, room);
    if (points > 0) {
      kept.push({ type: a.type, points });
      running += points;
    }
  }
  return kept;
}
