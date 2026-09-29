import { Injectable, Logger } from '@nestjs/common';
import { PointEventType, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/** A Prisma client or an interactive-transaction client — mirrors NotificationService. */
type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export type AwardInput = {
  promoterId: string;
  type: PointEventType;
  /** Points to record; may be negative (penalties, reversals). */
  points: number;
  /** Idempotency key — one source event yields at most one award of a type. */
  dedupeKey: string;
  seasonKey: string;
  submissionId?: string;
  assignmentId?: string;
  campaignId?: string;
  occurredAt?: Date;
  metadata?: Prisma.InputJsonValue;
};

/**
 * Writes to the append-only points ledger (docs/LEADERBOARD.md §2/§8). `award` is the
 * single entry point — Phase-1 hooks call it from inside their own transactions so a
 * point can't be lost if the event that earned it commits.
 *
 * Aggregation into promoter_scores / ranks / tiers is a later phase; this service only
 * records events.
 */
@Injectable()
export class PointsService {
  private readonly logger = new Logger(PointsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record one point event. Idempotent: a second award with the same dedupeKey (a
   * retried request, a double-wired hook) is silently ignored. Returns true when a new
   * row was created, false when it was a duplicate. Pass a tx to enlist it in the
   * caller's transaction.
   */
  async award(input: AwardInput, tx: Tx = this.prisma): Promise<boolean> {
    if (!Number.isInteger(input.points)) {
      throw new Error(`points must be an integer, got ${input.points}`);
    }
    try {
      await tx.pointEvent.create({
        data: {
          promoterId: input.promoterId,
          type: input.type,
          points: input.points,
          dedupeKey: input.dedupeKey,
          seasonKey: input.seasonKey,
          submissionId: input.submissionId,
          assignmentId: input.assignmentId,
          campaignId: input.campaignId,
          occurredAt: input.occurredAt ?? new Date(),
          metadata: input.metadata,
        },
      });
      return true;
    } catch (err) {
      // Unique violation on dedupeKey → already awarded; not an error.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
      throw err;
    }
  }
}
