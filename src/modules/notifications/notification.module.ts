import { Module } from '@nestjs/common';
import { MailerModule } from '../../common/mailer/mailer.module';
import { NotificationController } from './notification.controller';
import { NotificationScheduler } from './notification.scheduler';
import { NotificationService } from './notification.service';

@Module({
  // MailerModule is @Global, but importing it here makes MAILER resolvable wherever
  // NotificationModule is used — including partial test graphs that never import it.
  imports: [MailerModule],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationScheduler],
  exports: [NotificationService],
})
export class NotificationModule {}
