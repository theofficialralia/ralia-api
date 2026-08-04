import { Mailer, MailMessage } from './mailer';

/**
 * Resend transport (staging/prod). Uses the HTTP API directly via global fetch —
 * no SDK dependency. A non-2xx response throws so the dispatch sweep retries.
 */
export class ResendMailer implements Mailer {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend send failed: ${res.status} ${detail.slice(0, 200)}`);
    }
  }
}
