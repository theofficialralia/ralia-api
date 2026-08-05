import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import { OtpProvider, OtpRecipient } from './otp-provider';

export type WhatsAppOtpConfig = {
  phoneNumberId: string;
  accessToken: string;
  template: string;
  languageCode: string; // e.g. 'en' or 'en_US' — must match the approved template
  graphVersion?: string;
};

/**
 * Delivers the code via the WhatsApp Business Cloud API using a pre-approved
 * Authentication-category template. Only wired when the WHATSAPP_* envs are present
 * (see identity.module); until then it is never constructed. The template must take
 * the code as its single body parameter and echo it in a copy-code/one-tap button —
 * adjust the components below to match your approved template if it differs.
 */
export class WhatsAppOtpProvider implements OtpProvider {
  readonly name = 'whatsapp';
  private readonly logger = new Logger(WhatsAppOtpProvider.name);

  constructor(private readonly config: WhatsAppOtpConfig) {}

  async send(to: OtpRecipient, code: string, _purpose: OtpPurpose): Promise<void> {
    const version = this.config.graphVersion ?? 'v21.0';
    const url = `https://graph.facebook.com/${version}/${this.config.phoneNumberId}/messages`;
    // Cloud API wants the number in international format, digits only (no '+').
    const toDigits = to.phone.replace(/[^\d]/g, '');

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toDigits,
        type: 'template',
        template: {
          name: this.config.template,
          language: { code: this.config.languageCode },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.warn(`WhatsApp OTP send failed: ${res.status} ${detail.slice(0, 300)}`);
      throw new ServiceUnavailableException('Could not send the WhatsApp code.');
    }
  }
}
