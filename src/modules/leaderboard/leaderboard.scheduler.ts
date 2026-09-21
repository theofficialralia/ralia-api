import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { LeaderboardService } from './leaderboard.service';

/**
 * Runs the nightly leaderboard rebuild (docs/LEADERBOARD.md §6). Separate from the
 * service so specs can call rebuildAll directly without a timer firing. Recomputing on
 * a schedule (not only on events) is what makes tiers DECAY: an inactive promoter's
 * rolling-90 points age out and their tier drops even though they earned nothing.
 */
@Injectable()
export class LeaderboardScheduler {
  private readonly logger = new Logger(LeaderboardScheduler.name);
  private running = false;

  constructor(private readonly leaderboard: LeaderboardService) {}

  @Interval('leaderboard-rebuild', 24 * 60 * 60 * 1000)
  async rebuild(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.leaderboard.rebuildAll(new Date());
    } catch (err) {
      this.logger.error('Leaderboard rebuild failed', err instanceof Error ? err.stack : String(err));
    } finally {
      this.running = false;
    }
  }
}
