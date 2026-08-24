import { AssignmentStatus, DeliverySlotStatus } from '@prisma/client';
import { computeAssignmentRollup, hasConsecutiveMisses, outstandingCount, SlotView } from './delivery';
import { generateSlotSchedule } from '../../modules/matching/matching.service';

const slot = (index: number, status: DeliverySlotStatus): SlotView => ({ index, status });

describe('delivery — assignment roll-up (§multi-day)', () => {
  it('is IN_PROGRESS while any post is still to do', () => {
    const r = computeAssignmentRollup([slot(1, 'APPROVED'), slot(2, 'PENDING')]);
    expect(r.status).toBe(AssignmentStatus.IN_PROGRESS);
    expect(r.allResolved).toBe(false);
  });

  it('is SUBMITTED when the only outstanding posts are awaiting review', () => {
    const r = computeAssignmentRollup([slot(1, 'APPROVED'), slot(2, 'SUBMITTED')]);
    expect(r.status).toBe(AssignmentStatus.SUBMITTED);
  });

  it('is PAID once every post is resolved and at least one was approved', () => {
    const r = computeAssignmentRollup([slot(1, 'APPROVED'), slot(2, 'MISSED')]);
    expect(r.status).toBe(AssignmentStatus.PAID);
    expect(r.allResolved).toBe(true);
    expect(r.anyApproved).toBe(true);
  });

  it('is CANCELLED when every post is resolved but none was approved', () => {
    const r = computeAssignmentRollup([slot(1, 'MISSED'), slot(2, 'MISSED')]);
    expect(r.status).toBe(AssignmentStatus.CANCELLED);
    expect(r.anyApproved).toBe(false);
  });

  it('a rejected post keeps the assignment actionable (IN_PROGRESS)', () => {
    expect(computeAssignmentRollup([slot(1, 'REJECTED')]).status).toBe(AssignmentStatus.IN_PROGRESS);
  });
});

describe('delivery — consecutive misses (re-allocation trigger)', () => {
  it('flags two misses back-to-back', () => {
    expect(hasConsecutiveMisses([slot(1, 'MISSED'), slot(2, 'MISSED'), slot(3, 'PENDING')])).toBe(true);
  });

  it('does not flag two non-adjacent misses', () => {
    expect(hasConsecutiveMisses([slot(1, 'MISSED'), slot(2, 'APPROVED'), slot(3, 'MISSED')])).toBe(false);
  });

  it('a single miss is not a trigger', () => {
    expect(hasConsecutiveMisses([slot(1, 'MISSED'), slot(2, 'PENDING')])).toBe(false);
  });

  it('counts posts still owed', () => {
    expect(outstandingCount([slot(1, 'MISSED'), slot(2, 'PENDING'), slot(3, 'REJECTED'), slot(4, 'APPROVED')])).toBe(2);
  });
});

describe('delivery — slot schedule generation', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  it('a one-off is a single slot due at the buffered window end', () => {
    const now = Date.parse('2026-09-01T00:00:00Z');
    const end = new Date(now + 10 * DAY);
    const s = generateSlotSchedule(null, end, 1, 24, 48 * HOUR, now);
    expect(s).toHaveLength(1);
    // end − 24h buffer.
    expect(s[0]!.dueAt.getTime()).toBe(end.getTime() - 24 * HOUR);
  });

  it('a one-off with no end date uses the flat delivery window', () => {
    const now = Date.parse('2026-09-01T00:00:00Z');
    const s = generateSlotSchedule(null, null, 1, 24, 48 * HOUR, now);
    expect(s[0]!.dueAt.getTime()).toBe(now + 48 * HOUR);
  });

  it('spreads N posts across the usable window, last one before the buffer', () => {
    const now = Date.parse('2026-09-01T00:00:00Z');
    const start = new Date(now);
    const end = new Date(now + 14 * DAY);
    const s = generateSlotSchedule(start, end, 7, 24, 48 * HOUR, now);
    expect(s).toHaveLength(7);
    expect(s.map((x) => x.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Monotonically increasing deadlines.
    for (let i = 1; i < s.length; i++) {
      expect(s[i]!.dueAt.getTime()).toBeGreaterThan(s[i - 1]!.dueAt.getTime());
    }
    // The final post is due no later than end − buffer.
    expect(s[6]!.dueAt.getTime()).toBeLessThanOrEqual(end.getTime() - 24 * HOUR);
  });
});
