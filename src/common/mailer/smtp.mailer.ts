import { Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Mailer, MailMessage } from './mailer';

/** SMTP transport (mailpit in dev, a real relay in prod). */
export class SmtpMailer implements Mailer {
  readonly name = 'smtp';
  private readonly transport: nodemailer.Transporter;

  constructor(
    private readonly from: string,
    options: { host: string; port: number; user?: string; pass?: string },
  ) {
    this.transport = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      // mailpit and most dev relays are plaintext on 1025; TLS kicks in on 465.
      secure: options.port === 465,
      auth: options.user ? { user: options.user, pass: options.pass } : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

/** No-op transport: logs instead of sending. Used when SMTP is unconfigured. */
export class LogMailer implements Mailer {
  readonly name = 'log';
  private readonly logger = new Logger('LogMailer');

  async send(message: MailMessage): Promise<void> {
    this.logger.log(`[email suppressed] to=${message.to} subject="${message.subject}"`);
  }
}
