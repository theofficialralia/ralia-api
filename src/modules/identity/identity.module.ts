import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { ConsoleOtpProvider } from './providers/console-otp.provider';
import { OTP_PROVIDER } from './providers/otp-provider';
import { SessionService } from './session.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    OtpService,
    SessionService,
    {
      // Swap by config when a real adapter exists (B2 harden). The interface is
      // the contract; nothing in auth knows which one is bound.
      provide: OTP_PROVIDER,
      useClass: ConsoleOtpProvider,
    },
  ],
  exports: [SessionService],
})
export class IdentityModule {}
