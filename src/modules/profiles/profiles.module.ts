import { Module } from '@nestjs/common';
import { BankService } from './bank.service';
import { ChannelsService } from './channels.service';
import { ProfileService } from './profile.service';
import { PromotersController } from './promoters.controller';

@Module({
  controllers: [PromotersController],
  providers: [ProfileService, ChannelsService, BankService],
  exports: [ProfileService, ChannelsService, BankService],
})
export class ProfilesModule {}
