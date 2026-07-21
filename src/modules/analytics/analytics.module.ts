import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Read-only reporting for clients. The four SOW metrics (views, accepted,
 * completed, amount spent) plus the evidence gallery — nothing beyond that
 * (handoff §11 keeps richer analytics out of scope).
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
