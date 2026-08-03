import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationEmailStatus, Prisma, PrismaClient } from '@prisma/client';
import { MAILER, Mailer } from '../../common/mailer/mailer';
import { PrismaService } from '../../common/prisma/prisma.service';

/** A Prisma client or an interactive-transaction client — mirrors LedgerService. */
type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export type NotifyInput = {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Prisma.InputJsonValue;
  /** Idempotency: a second create with the same key is silently ignored. */
  dedupeKey?: string;
  /** false → in-app only, never emailed (status SKIPPED). Defaults to true. */
  email?: boolean;
};

/** Give up emailing after this many failed attempts. */
const MAX_ATTEMPTS = 3;

/**
 * Durable per-user notifications (N-1). `create` persists a record — optionally inside
 * the caller's transaction, so a notification can't be lost if the event that spawned
 * it commits. `dispatchPending` is the sweep that emails the PENDING backlog, decoupled
 * from the request path so a slow or down SMTP never blocks or fails a core action.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  /**
   * Persist a notification. Idempotent when a dedupeKey is given: a collision on the
   * unique key (retried request, double-wired event) is swallowed, not raised. Pass a
   * tx to enlist it in the caller's transaction.
   */
  async create(input: NotifyInput, tx: Tx = this.prisma): Promise<void> {
    try {
      await tx.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          title: input.title,
          body: input.body,
          data: input.data,
          dedupeKey: input.dedupeKey,
          emailStatus: input.email === false ? NotificationEmailStatus.SKIPPED : NotificationEmailStatus.PENDING,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return; // already notified
      throw err;
    }
  }

  /**
   * Email the PENDING backlog, oldest first. Each success → SENT; each failure bumps
   * the attempt count and stays PENDING for the next sweep, until MAX_ATTEMPTS → FAILED.
   * One failing message never blocks the others.
   */
  async dispatchPending(now: Date, limit = 50): Promise<{ sent: number; failed: number }> {
    const pending = await this.prisma.notification.findMany({
      where: { emailStatus: NotificationEmailStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { user: { select: { email: true } } },
    });

    let sent = 0;
    let failed = 0;
    for (const n of pending) {
      try {
        await this.mailer.send({ to: n.user.email, subject: n.title, text: n.body });
        await this.prisma.notification.update({
          where: { id: n.id },
          data: { emailStatus: NotificationEmailStatus.SENT, emailedAt: now, emailAttempts: { increment: 1 } },
        });
        sent++;
      } catch (err) {
        const attempts = n.emailAttempts + 1;
        const exhausted = attempts >= MAX_ATTEMPTS;
        await this.prisma.notification.update({
          where: { id: n.id },
          data: {
            emailAttempts: attempts,
            emailStatus: exhausted ? NotificationEmailStatus.FAILED : NotificationEmailStatus.PENDING,
            emailError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          },
        });
        if (exhausted) failed++;
      }
    }

    if (sent > 0 || failed > 0) this.logger.log(`Dispatched notifications: ${sent} sent, ${failed} failed.`);
    return { sent, failed };
  }
}
