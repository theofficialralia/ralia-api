import { Module } from '@nestjs/common';
import { RateConfigModule } from '../../common/rate-config/rate-config.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuditService } from './audit.service';

@Module({
  imports: [LedgerModule, RateConfigModule],
  controllers: [AdminController],
  providers: [AdminService, AuditService],
  exports: [AuditService],
})
export class AdminModule {}
