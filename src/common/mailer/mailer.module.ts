import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAILER } from './mailer';
import { ResendMailer } from './resend.mailer';
import { LogMailer, SmtpMailer } from './smtp.mailer';

/**
 * Binds the MAILER token from config:
 *   - Resend when MAIL_TRANSPORT=resend and RESEND_API_KEY is set (staging/prod)
 *   - SMTP when MAIL_TRANSPORT=smtp and a host is set (mailpit in dev)
 *   - otherwise a log/no-op transport, so tests and unconfigured environments never
 *     attempt a real send.
 * Global so any module can inject MAILER.
 */
@Global()
@Module({
  providers: [
    {
      provide: MAILER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const transport = config.get<string>('MAIL_TRANSPORT');
        const from = config.get<string>('MAIL_FROM') ?? 'Ralia <no-reply@ralia.co>';
        const resendKey = config.get<string>('RESEND_API_KEY');
        const host = config.get<string>('SMTP_HOST');

        if (transport === 'resend' && resendKey) {
          return new ResendMailer(resendKey, from);
        }
        if (transport === 'smtp' && host) {
          return new SmtpMailer(from, {
            host,
            port: Number(config.get<string>('SMTP_PORT') ?? 1025),
            user: config.get<string>('SMTP_USER'),
            pass: config.get<string>('SMTP_PASS'),
          });
        }
        return new LogMailer();
      },
    },
  ],
  exports: [MAILER],
})
export class MailerModule {}
