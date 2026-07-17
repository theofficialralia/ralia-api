import { Global, Module } from '@nestjs/common';
import { RateConfigService } from './rate-config.service';

@Global()
@Module({
  providers: [RateConfigService],
  exports: [RateConfigService],
})
export class RateConfigModule {}
