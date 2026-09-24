import { Global, Module } from '@nestjs/common';
import { MetaConversionsService } from './meta-conversions.service';

/**
 * Server-side marketing/telemetry integrations. Global so any module can inject
 * MetaConversionsService to mirror a browser conversion server-side.
 */
@Global()
@Module({
  providers: [MetaConversionsService],
  exports: [MetaConversionsService],
})
export class MarketingModule {}
