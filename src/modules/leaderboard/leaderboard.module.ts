import { Global, Module } from '@nestjs/common';
import { LeaderboardConfigService } from './leaderboard-config.service';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardScheduler } from './leaderboard.scheduler';
import { LeaderboardService } from './leaderboard.service';
import { PointsService } from './points.service';

/**
 * Leaderboard & tiers (docs/LEADERBOARD.md). Global so the delivery hooks (admin
 * approvals, the reclaim sweep) can inject PointsService + LeaderboardService without
 * importing the module everywhere — same pattern as RateConfigModule.
 */
@Global()
@Module({
  controllers: [LeaderboardController],
  providers: [PointsService, LeaderboardConfigService, LeaderboardService, LeaderboardScheduler],
  exports: [PointsService, LeaderboardConfigService, LeaderboardService],
})
export class LeaderboardModule {}
