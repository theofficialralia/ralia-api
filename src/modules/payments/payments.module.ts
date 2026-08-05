import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaystackService } from './paystack.service';
import { PaystackWebhookController } from './paystack-webhook.controller';

@Module({
  imports: [LedgerModule, AdminModule],
  controllers: [PaymentsController, PaystackWebhookController],
  providers: [PaymentsService, PaystackService],
})
export class PaymentsModule {}
