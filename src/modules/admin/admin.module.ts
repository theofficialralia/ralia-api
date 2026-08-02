import { Module } from '@nestjs/common';
import { RateConfigModule } from '../../common/rate-config/rate-config.module';
import { StorageModule } from '../../common/storage/storage.module';
import { AllocationModule } from '../allocation/allocation.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ScoringModule } from '../scoring/scoring.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuditService } from './audit.service';

@Module({
  imports: [LedgerModule, RateConfigModule, StorageModule, ScoringModule, AllocationModule],
  controllers: [AdminController],
  providers: [AdminService, AuditService],
  exports: [AuditService],
})
export class AdminModule {}
