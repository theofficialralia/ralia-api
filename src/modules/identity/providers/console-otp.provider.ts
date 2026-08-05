import { Injectable, Logger } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { appendFileSync } from 'node:fs';
import { OtpProvider, OtpRecipient } from './otp-provider';

/**
 * Dev-only. Prints the code to the console so you can log in without an SMS
 * bill, and appends it to DEV_OTP_LOG so the end-to-end verification script can
 * complete a real signup through the API rather than reaching into the database.
 *
 * Refuses to run in production: handoff §2 forbids logging OTPs, and this
 * provider's entire job is to log one. Better to crash at boot than to quietly
 * write live codes to disk. Everything below therefore inherits that guarantee.
 */
@Injectable()
export class ConsoleOtpProvider implements OtpProvider {
  readonly name = 'console';
  private readonly logger = new Logger(ConsoleOtpProvider.name);

  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'ConsoleOtpProvider must never run in production — it writes OTP codes to the log and to disk. Set OTP_PROVIDER to a real adapter.',
      );
    }
  }

  async send(to: OtpRecipient, code: string, purpose: OtpPurpose): Promise<void> {
    this.logger.log(`OTP for ${to.phone} (${purpose}): ${code}`);

    const path = process.env.DEV_OTP_LOG;
    if (!path) return;
    try {
      // Keyed by phone so the e2e harness (which knows the phone) can find the code.
      appendFileSync(path, `${to.phone} ${purpose} ${code}\n`);
    } catch (err) {
      // Never fail a signup because a dev convenience file is unwritable.
      this.logger.warn(`Could not write ${path}: ${(err as Error).message}`);
    }
  }
}
