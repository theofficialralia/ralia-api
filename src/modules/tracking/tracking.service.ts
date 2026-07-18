import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Obvious automated agents. This is the thin heuristic — a cheap UA check so the
 * is_bot column is meaningful. Real bot filtering (per-IP-hash rate limiting,
 * headless-browser signals) is the harden slice.
 */
const OBVIOUS_BOT = /bot|crawl|spider|slurp|curl|wget|python-requests|axios|headless|preview|facebookexternalhit|whatsapp|telegrambot/i;

export type ClickContext = {
  ip: string;
  userAgent: string;
  referrer?: string;
};

export type Resolution = { destinationUrl: string } | null;

@Injectable()
export class TrackingService {
  private readonly logger = new Logger(TrackingService.name);

  constructor(private readonly prisma: PrismaService) {}

  private get salt(): string {
    return process.env.TRACKING_HASH_SALT ?? '';
  }

  private hash(value: string): string {
    return createHash('sha256').update(`${this.salt}:${value}`).digest('hex');
  }

  /**
   * Resolves a tracking token to its destination and records the click.
   *
   * The redirect is the user-facing function; the click is analytics. A failed
   * click write must never deny the user their redirect, so recording is
   * best-effort and its failure is logged, not thrown.
   *
   * Thin slice: one direct insert per click. The buffer + batch flush that keeps
   * this fast under load is the harden slice — the loop only needs the click to
   * land, not to be cheap.
   */
  async resolveAndRecord(token: string, ctx: ClickContext): Promise<Resolution> {
    const link = await this.prisma.trackingLink.findUnique({ where: { token } });
    if (!link || !link.destinationUrl) return null;

    const isBot = OBVIOUS_BOT.test(ctx.userAgent);
    try {
      await this.prisma.clickEvent.create({
        data: {
          token,
          ipHash: this.hash(ctx.ip),
          uaHash: this.hash(ctx.userAgent),
          isBot,
          referrer: ctx.referrer ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(`Failed to record click for token ${token}: ${(err as Error).message}`);
    }

    return { destinationUrl: link.destinationUrl };
  }
}
