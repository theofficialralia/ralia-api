import { Module } from '@nestjs/common';
import { AssetsService } from './assets.service';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';

@Module({
  controllers: [CampaignsController],
  providers: [CampaignsService, AssetsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
