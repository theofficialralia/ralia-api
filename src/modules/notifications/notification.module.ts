import { Module } from '@nestjs/common';
import { MailerModule } from '../../common/mailer/mailer.module';
import { NotificationScheduler } from './notification.scheduler';
import { NotificationService } from './notification.service';

@Module({
  // MailerModule is @Global, but importing it here makes MAILER resolvable wherever
  // NotificationModule is used — including partial test graphs that never import it.
  imports: [MailerModule],
  providers: [NotificationService, NotificationScheduler],
  exports: [NotificationService],
})
export class NotificationModule {}
