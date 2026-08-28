import { Module } from '@nestjs/common';
import { MailerModule } from '../../common/mailer/mailer.module';
import { RateConfigModule } from '../../common/rate-config/rate-config.module';
import { StorageModule } from '../../common/storage/storage.module';
import { AllocationModule } from '../allocation/allocation.module';
import { LedgerModule } from '../ledger/ledger.module';
import { NotificationModule } from '../notifications/notification.module';
import { ScoringModule } from '../scoring/scoring.module';
import { IdentityModule } from '../identity/identity.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuditService } from './audit.service';
import { TeamController } from './team.controller';
import { TeamService } from './team.service';

@Module({
  imports: [LedgerModule, RateConfigModule, StorageModule, ScoringModule, AllocationModule, NotificationModule, IdentityModule, MailerModule],
  controllers: [AdminController, TeamController],
  providers: [AdminService, AuditService, TeamService],
  exports: [AuditService],
})
export class AdminModule {}
