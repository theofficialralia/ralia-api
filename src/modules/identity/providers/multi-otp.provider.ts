import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { OtpProvider, OtpRecipient } from './otp-provider';

/**
 * Fans one code out to several channels (e.g. email + WhatsApp). Each channel is
 * best-effort: one failing does not stop the others, so a WhatsApp outage still lets
 * the email land. It only throws if EVERY channel failed — otherwise the user got the
 * code somewhere.
 */
export class MultiOtpProvider implements OtpProvider {
  readonly name: string;
  private readonly logger = new Logger(MultiOtpProvider.name);

  constructor(private readonly channels: OtpProvider[]) {
    this.name = `multi(${channels.map((c) => c.name).join('+')})`;
  }

  async send(to: OtpRecipient, code: string, purpose: OtpPurpose): Promise<void> {
    const results = await Promise.allSettled(this.channels.map((c) => c.send(to, code, purpose)));
    const failures = results.filter((r) => r.status === 'rejected');

    for (const f of failures) {
      if (f.status === 'rejected') this.logger.warn(`OTP channel failed: ${f.reason instanceof Error ? f.reason.message : String(f.reason)}`);
    }
    if (failures.length === this.channels.length) {
      throw new ServiceUnavailableException('Could not deliver the verification code on any channel.');
    }
  }
}
