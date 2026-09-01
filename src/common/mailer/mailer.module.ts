import { Global, Logger, Module } from '@nestjs/common';
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
        const logger = new Logger('MailerModule');
        const transport = config.get<string>('MAIL_TRANSPORT');
        const from = config.get<string>('MAIL_FROM') ?? 'Ralia <no-reply@ralia.co>';
        const resendKey = config.get<string>('RESEND_API_KEY');
        const host = config.get<string>('SMTP_HOST');

        if (transport === 'resend' && resendKey) {
          logger.log(`Email via Resend, from ${from}.`);
          return new ResendMailer(resendKey, from);
        }
        if (transport === 'smtp' && host) {
          logger.log(`Email via SMTP ${host}, from ${from}.`);
          return new SmtpMailer(from, {
            host,
            port: Number(config.get<string>('SMTP_PORT') ?? 1025),
            user: config.get<string>('SMTP_USER'),
            pass: config.get<string>('SMTP_PASS'),
          });
        }
        // No real transport configured → emails are only logged, never delivered.
        // In dev that's expected; anywhere else it silently breaks signup/verification,
        // so shout about it loudly rather than failing invisibly.
        const misconfigured =
          transport === 'resend' ? 'MAIL_TRANSPORT=resend but RESEND_API_KEY is missing'
          : transport === 'smtp' ? 'MAIL_TRANSPORT=smtp but SMTP_HOST is missing'
          : 'MAIL_TRANSPORT is not set';
        const env = config.get<string>('NODE_ENV');
        const msg = `Email is NOT being delivered (${misconfigured}) — using a log-only mailer. Verification and notification emails will NOT arrive.`;
        if (env && env !== 'development' && env !== 'test') logger.error(`⚠️  ${msg} Set MAIL_TRANSPORT + RESEND_API_KEY (and verify your sending domain) in this environment.`);
        else logger.warn(msg);
        return new LogMailer();
      },
    },
  ],
  exports: [MAILER],
})
export class MailerModule {}
