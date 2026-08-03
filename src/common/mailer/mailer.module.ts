import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAILER } from './mailer';
import { LogMailer, SmtpMailer } from './smtp.mailer';

/**
 * Binds the MAILER token from config. SMTP when MAIL_TRANSPORT=smtp and a host is
 * set; otherwise a log/no-op transport, so tests and unconfigured environments never
 * attempt a real send. Global so any module can inject MAILER.
 */
@Global()
@Module({
  providers: [
    {
      provide: MAILER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const transport = config.get<string>('MAIL_TRANSPORT');
        const host = config.get<string>('SMTP_HOST');
        if (transport === 'smtp' && host) {
          return new SmtpMailer(config.get<string>('MAIL_FROM') ?? 'Ralia <no-reply@ralia.local>', {
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
