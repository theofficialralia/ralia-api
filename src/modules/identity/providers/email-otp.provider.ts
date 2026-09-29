import { Logger } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { Mailer } from '../../../common/mailer/mailer';
import { renderBrandedEmail } from '../../../common/mailer/email-template';
import { OtpProvider, OtpRecipient, otpPurposeLabel } from './otp-provider';

/**
 * Delivers the code by email through the shared MAILER (Resend in prod, mailpit in dev).
 * If the account has no email on file the send is skipped with a warning — never crash
 * an auth flow over a missing contact point; another channel may still carry the code.
 */
export class EmailOtpProvider implements OtpProvider {
  readonly name = 'email';
  private readonly logger = new Logger(EmailOtpProvider.name);

  constructor(private readonly mailer: Mailer) {}

  async send(to: OtpRecipient, code: string, purpose: OtpPurpose): Promise<void> {
    if (!to.email) {
      this.logger.warn(`No email on file — cannot email an OTP (${purpose}).`);
      return;
    }
    const action = otpPurposeLabel(purpose);
    await this.mailer.send({
      to: to.email,
      subject: `${code} is your Ralia code`,
      text: `Your Ralia verification code is ${code}. Enter it to ${action}. It expires shortly — don't share it with anyone.`,
      html: renderBrandedEmail({
        heading: 'Your verification code',
        paragraphs: [`Enter this code to ${action}. It expires shortly — never share it with anyone.`],
        code,
        preheader: `Your Ralia code is ${code}`,
      }),
    });
  }
}
