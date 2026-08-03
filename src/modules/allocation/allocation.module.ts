import { Module } from '@nestjs/common';
import { RateConfigModule } from '../../common/rate-config/rate-config.module';
import { MatchingModule } from '../matching/matching.module';
import { NotificationModule } from '../notifications/notification.module';
import { ScoringModule } from '../scoring/scoring.module';
import { AllocationScheduler } from './allocation.scheduler';
import { AllocationService } from './allocation.service';

@Module({
  imports: [ScoringModule, MatchingModule, RateConfigModule, NotificationModule],
  providers: [AllocationService, AllocationScheduler],
  exports: [AllocationService],
})
export class AllocationModule {}
