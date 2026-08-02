import { Module } from '@nestjs/common';
import { RateConfigModule } from '../../common/rate-config/rate-config.module';
import { MatchingModule } from '../matching/matching.module';
import { ScoringModule } from '../scoring/scoring.module';
import { AllocationScheduler } from './allocation.scheduler';
import { AllocationService } from './allocation.service';

@Module({
  imports: [ScoringModule, MatchingModule, RateConfigModule],
  providers: [AllocationService, AllocationScheduler],
  exports: [AllocationService],
})
export class AllocationModule {}
