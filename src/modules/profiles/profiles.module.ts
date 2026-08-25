import { Module } from '@nestjs/common';
import { StorageModule } from '../../common/storage/storage.module';
import { PaystackService } from '../payments/paystack.service';
import { BankService } from './bank.service';
import { ChannelsService } from './channels.service';
import { ProfileService } from './profile.service';
import { PromotersController } from './promoters.controller';

@Module({
  imports: [StorageModule],
  controllers: [PromotersController],
  // PaystackService is stateless (env + fetch), so it's provided directly here for
  // bank list / account resolve — no coupling to the payments module.
  providers: [ProfileService, ChannelsService, BankService, PaystackService],
  exports: [ProfileService, ChannelsService, BankService],
})
export class ProfilesModule {}
