import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { OtpPurpose } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OTP_PROVIDER, OtpProvider } from './providers/otp-provider';

const MAX_ATTEMPTS = 5;

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_PROVIDER) private readonly provider: OtpProvider,
  ) {}

  private get ttlSeconds(): number {
    return Number(process.env.OTP_TTL_SECONDS ?? 600);
  }

  /**
   * Issues a code and sends it. Any previous unconsumed code for this purpose is
   * consumed first, so only the newest code ever works.
   */
  async issue(userId: string, phone: string, purpose: OtpPurpose): Promise<void> {
    // randomInt is crypto-backed and rejection-samples, so digits are uniform —
    // Math.random() here would be a real weakness, not a style nit.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = await argon2.hash(code);

    await this.prisma.$transaction(async (tx) => {
      await tx.otpCode.updateMany({
        where: { userId, purpose, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.otpCode.create({
        data: {
          userId,
          purpose,
          codeHash,
          expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
        },
      });
    });

    // The email address is a delivery channel's contact point — the code itself is
    // the same whichever channel carries it.
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    await this.provider.send({ phone, email: user?.email ?? null }, code, purpose);
  }

  /**
   * Consumes the code on success. Attempts are counted per code, so guessing is
   * bounded even within the TTL.
   */
  async verify(userId: string, purpose: OtpPurpose, code: string): Promise<boolean> {
    const otp = await this.prisma.otpCode.findFirst({
      where: { userId, purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp) return false;

    if (otp.expiresAt < new Date()) {
      throw new BadRequestException('That code has expired. Request a new one.');
    }
    if (otp.attempts >= MAX_ATTEMPTS) {
      throw new BadRequestException('Too many incorrect attempts. Request a new code.');
    }

    const ok = await argon2.verify(otp.codeHash, code);

    if (!ok) {
      await this.prisma.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      return false;
    }

    await this.prisma.otpCode.update({
      where: { id: otp.id },
      data: { consumedAt: new Date() },
    });
    return true;
  }
}
