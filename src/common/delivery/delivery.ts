import { AssignmentStatus, DeliverySlotStatus } from '@prisma/client';

/**
 * §multi-day delivery-slot helpers. A recurring assignment holds many DeliverySlots
 * (one per scheduled post); the assignment's own status is a roll-up of them, and
 * re-allocation is triggered by consecutive misses. These are pure functions so the
 * evidence, admin, and allocation services can share one source of truth.
 */

export type SlotView = { index: number; status: DeliverySlotStatus };

export type AssignmentRollup = {
  status: AssignmentStatus;
  allResolved: boolean; // every slot terminal (APPROVED or MISSED)
  anyApproved: boolean;
};

/**
 * The assignment status implied by its slots:
 * - all slots terminal → PAID if any post was approved, else CANCELLED (delivered nothing).
 * - any slot still PENDING/REJECTED → IN_PROGRESS (the promoter still has posts to do).
 * - otherwise (only SUBMITTED/APPROVED left, at least one awaiting review) → SUBMITTED.
 */
export function computeAssignmentRollup(slots: SlotView[]): AssignmentRollup {
  const allResolved = slots.every((s) => s.status === 'APPROVED' || s.status === 'MISSED');
  const anyApproved = slots.some((s) => s.status === 'APPROVED');
  const anyOutstanding = slots.some((s) => s.status === 'PENDING' || s.status === 'REJECTED');
  const anyInReview = slots.some((s) => s.status === 'SUBMITTED');

  let status: AssignmentStatus;
  if (allResolved) status = anyApproved ? AssignmentStatus.PAID : AssignmentStatus.CANCELLED;
  else if (anyOutstanding) status = AssignmentStatus.IN_PROGRESS;
  else if (anyInReview) status = AssignmentStatus.SUBMITTED;
  else status = AssignmentStatus.IN_PROGRESS;

  return { status, allResolved, anyApproved };
}

/**
 * True when two or more posts were missed back-to-back (by index). This is the
 * re-allocation trigger: a single miss forfeits that post's pro-rata pay, but two
 * in a row means the promoter is failing and the campaign's reach projection is at
 * risk — the remaining posts should be re-offered to someone else.
 */
export function hasConsecutiveMisses(slots: SlotView[], threshold = 2): boolean {
  const ordered = [...slots].sort((a, b) => a.index - b.index);
  let run = 0;
  for (const s of ordered) {
    if (s.status === 'MISSED') {
      run += 1;
      if (run >= threshold) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

/** Posts not yet delivered — remaining work to re-offer after a promoter fails. */
export function outstandingCount(slots: SlotView[]): number {
  return slots.filter((s) => s.status === 'PENDING' || s.status === 'REJECTED').length;
}
