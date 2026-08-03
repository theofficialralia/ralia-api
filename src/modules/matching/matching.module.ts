import { Module } from '@nestjs/common';
import { NotificationModule } from '../notifications/notification.module';
import { MatchingController } from './matching.controller';
import { MatchingService } from './matching.service';
import { AssignmentsController, OffersController } from './offers.controller';

@Module({
  imports: [NotificationModule],
  controllers: [MatchingController, OffersController, AssignmentsController],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
