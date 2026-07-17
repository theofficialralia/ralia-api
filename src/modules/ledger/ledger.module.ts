import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';

/**
 * All money access goes through LedgerService commands. This module touches
 * nothing outside itself — handoff §3.
 */
@Module({
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
