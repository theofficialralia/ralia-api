import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MAILER, Mailer } from '../../common/mailer/mailer';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { ConsoleOtpProvider } from './providers/console-otp.provider';
import { EmailOtpProvider } from './providers/email-otp.provider';
import { MultiOtpProvider } from './providers/multi-otp.provider';
import { OTP_PROVIDER, OtpProvider } from './providers/otp-provider';
import { WhatsAppOtpProvider } from './providers/whatsapp-otp.provider';
import { SessionService } from './session.service';

/**
 * Binds OTP delivery from config, mirroring MailerModule:
 *   - OTP_TRANSPORT=auto (default) uses every channel whose creds are present —
 *     WhatsApp when the WHATSAPP_* envs are set, email when MAIL_TRANSPORT is a real
 *     transport — and falls back to the console (dev) when nothing is configured.
 *   - OTP_TRANSPORT may also name channels explicitly, e.g. "email" or "email,whatsapp".
 * Adding the WhatsApp envs later flips it on with no code change.
 */
function buildOtpProvider(config: ConfigService, mailer: Mailer): OtpProvider {
  const transport = (config.get<string>('OTP_TRANSPORT') ?? 'auto').toLowerCase();
  const want = (channel: string): boolean =>
    transport === 'auto' || transport.split(',').map((s) => s.trim()).includes(channel);

  const waReady = !!(
    config.get<string>('WHATSAPP_ACCESS_TOKEN') &&
    config.get<string>('WHATSAPP_PHONE_NUMBER_ID') &&
    config.get<string>('WHATSAPP_OTP_TEMPLATE')
  );
  const mailReady = ['resend', 'smtp'].includes((config.get<string>('MAIL_TRANSPORT') ?? '').toLowerCase());

  const channels: OtpProvider[] = [];
  if (want('whatsapp') && waReady) {
    channels.push(
      new WhatsAppOtpProvider({
        phoneNumberId: config.get<string>('WHATSAPP_PHONE_NUMBER_ID')!,
        accessToken: config.get<string>('WHATSAPP_ACCESS_TOKEN')!,
        template: config.get<string>('WHATSAPP_OTP_TEMPLATE')!,
        languageCode: config.get<string>('WHATSAPP_OTP_TEMPLATE_LANG') ?? 'en',
      }),
    );
  }
  if (want('email') && mailReady) {
    channels.push(new EmailOtpProvider(mailer));
  }

  const logger = new Logger('IdentityModule');
  if (channels.length === 0) {
    // Nothing configured (or transport=console): dev console. Throws in production.
    logger.log('OTP delivery: console (no email/WhatsApp transport configured).');
    return new ConsoleOtpProvider();
  }
  logger.log(`OTP delivery via ${channels.map((c) => c.name).join(' + ')}.`);
  return channels.length === 1 ? channels[0]! : new MultiOtpProvider(channels);
}

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    OtpService,
    SessionService,
    {
      provide: OTP_PROVIDER,
      inject: [ConfigService, MAILER],
      useFactory: buildOtpProvider,
    },
  ],
  exports: [SessionService],
})
export class IdentityModule {}
