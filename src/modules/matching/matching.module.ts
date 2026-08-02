import { Module } from '@nestjs/common';
import { MatchingController } from './matching.controller';
import { MatchingService } from './matching.service';
import { AssignmentsController, OffersController } from './offers.controller';

@Module({
  controllers: [MatchingController, OffersController, AssignmentsController],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
