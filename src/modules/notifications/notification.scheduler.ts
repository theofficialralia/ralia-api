import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { NotificationService } from './notification.service';

/**
 * Emails the PENDING notification backlog every 30s. Separate from the allocation
 * sweep so delivery is timely and independent, and only wired where
 * ScheduleModule.forRoot() is (AppModule) — specs exercise dispatchPending directly.
 */
@Injectable()
export class NotificationScheduler {
  private readonly logger = new Logger(NotificationScheduler.name);
  private running = false;

  constructor(private readonly notifications: NotificationService) {}

  @Interval('notification-dispatch', 30_000)
  async dispatch(): Promise<void> {
    if (this.running) return; // single-flight: intervals don't await
    this.running = true;
    try {
      await this.notifications.dispatchPending(new Date());
    } catch (err) {
      this.logger.error('Notification dispatch failed', err instanceof Error ? err.stack : String(err));
    } finally {
      this.running = false;
    }
  }
}
