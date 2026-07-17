import { Injectable, Logger } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { OtpProvider } from './otp-provider';

/**
 * Dev-only. Prints the code to the console so you can log in without an SMS
 * bill.
 *
 * Refuses to run in production: handoff §2 forbids logging OTPs, and this
 * provider's entire job is to log one. Better to crash at boot than to quietly
 * print live codes into a production log aggregator.
 */
@Injectable()
export class ConsoleOtpProvider implements OtpProvider {
  readonly name = 'console';
  private readonly logger = new Logger(ConsoleOtpProvider.name);

  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'ConsoleOtpProvider must never run in production — it writes OTP codes to the log. Set OTP_PROVIDER to a real adapter.',
      );
    }
  }

  async send(to: string, code: string, purpose: OtpPurpose): Promise<void> {
    this.logger.log(`OTP for ${to} (${purpose}): ${code}`);
  }
}
