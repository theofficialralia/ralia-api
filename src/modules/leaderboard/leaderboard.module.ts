import { Global, Module } from '@nestjs/common';
import { LeaderboardConfigService } from './leaderboard-config.service';
import { PointsService } from './points.service';

/**
 * Leaderboard foundations (Phase 0, docs/LEADERBOARD.md). Global so Phase-1 hooks
 * (admin approvals, the reclaim sweep, onboarding) can inject PointsService without
 * importing the module everywhere — same pattern as RateConfigModule.
 */
@Global()
@Module({
  providers: [PointsService, LeaderboardConfigService],
  exports: [PointsService, LeaderboardConfigService],
})
export class LeaderboardModule {}
