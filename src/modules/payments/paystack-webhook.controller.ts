import { Controller, Headers, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../../common/auth/jwt-auth.guard';
import { PaymentsService } from './payments.service';

/**
 * Paystack calls this directly (server-to-server), so it is Public — there is no
 * session. Authenticity is the HMAC signature over the raw body, checked before we
 * act on anything. Kept off the OpenAPI surface (@ApiExcludeEndpoint).
 */
@Controller('payments/paystack')
export class PaystackWebhookController {
  constructor(private readonly payments: PaymentsService) {}

  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature: string,
  ): Promise<{ received: boolean }> {
    // rawBody is populated because bootstrap sets { rawBody: true }.
    await this.payments.handleWebhook(req.rawBody ?? Buffer.from(''), signature);
    // Always 200 to a validly-signed call so Paystack stops retrying; funding
    // itself is idempotent and logged.
    return { received: true };
  }
}
