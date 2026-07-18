import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

export type AuditEntry = {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
};

/**
 * Append-only audit of every money- or score-affecting write (handoff §4, §6).
 *
 * Always record inside the same transaction as the change it describes. An audit
 * row written afterwards can be lost when the write rolls back — or worse,
 * survive when the write fails — and either way the log stops being evidence.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: toJson(entry.before),
        after: toJson(entry.after),
        reason: entry.reason ?? null,
      },
    });
  }
}

/**
 * Prisma's Json column cannot take a bigint, and money columns are bigint
 * throughout — so stringify those rather than lose the audit row to a
 * serialisation error at the moment it matters most.
 */
function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
}
