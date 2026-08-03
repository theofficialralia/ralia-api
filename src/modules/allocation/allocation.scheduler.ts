import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AllocationService } from './allocation.service';

/**
 * Drives the §8 allocation sweeps on a fixed interval. Kept separate from the
 * service so specs can exercise the sweep logic directly without a timer ever
 * firing — this provider is only wired where ScheduleModule.forRoot() is (AppModule).
 */
@Injectable()
export class AllocationScheduler {
  private readonly logger = new Logger(AllocationScheduler.name);
  private running = false;

  constructor(private readonly allocation: AllocationService) {}

  /**
   * Every minute, in order: expire lapsed offers, reclaim blown-deadline slots back
   * to the pool, then allocate fresh offers across all LIVE campaigns — so slots freed
   * this tick are refilled in the same tick.
   */
  @Interval('allocation-sweep', 60_000)
  async sweep(): Promise<void> {
    // Guard against overlap if a sweep ever runs long — intervals don't await.
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      await this.allocation.expireStaleOffers(now);
      await this.allocation.reclaimOverdueAssignments(now);
      await this.allocation.allocateAll(now);
    } catch (err) {
      this.logger.error('Allocation sweep failed', err instanceof Error ? err.stack : String(err));
    } finally {
      this.running = false;
    }
  }
}
