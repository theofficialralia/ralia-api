import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ClientOrgStatus,
  ConsentPurpose,
  OtpPurpose,
  PromoterStatus,
  Role,
  UserStatus,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LoginDto, RegisterDto, RegisterResponseDto, TokenPairDto } from './dto/auth.dto';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';

/**
 * Identity: users, roles, sessions, OTP, consent. Never touches money — handoff §3.
 * Ledger accounts for a client org are created by the modules that need them.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
  ) {}

  private get policyVersion(): string {
    return process.env.POLICY_VERSION ?? '2026-07-01';
  }

  async register(dto: RegisterDto): Promise<RegisterResponseDto> {
    if (!dto.accepted_terms || !dto.accepted_privacy) {
      throw new BadRequestException('Terms and privacy policy must both be accepted.');
    }
    if (dto.role === Role.CLIENT && !dto.org_name?.trim()) {
      throw new BadRequestException('org_name is required when registering as a CLIENT.');
    }

    const clash = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phoneE164: dto.phone_e164 }] },
      select: { email: true, phoneE164: true },
    });
    if (clash) {
      // Which field clashed is already discoverable by trying each one, and
      // hiding it just makes the form unusable.
      throw new ConflictException(
        clash.email === dto.email ? 'That email is already registered.' : 'That phone number is already registered.',
      );
    }

    const passwordHash = await argon2.hash(dto.password);
    const now = new Date();

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: dto.email,
          phoneE164: dto.phone_e164,
          passwordHash,
          status: UserStatus.PENDING,
          roles: { create: { role: dto.role } },
          consents: {
            create: [
              {
                purpose: ConsentPurpose.TERMS_OF_SERVICE,
                granted: true,
                grantedAt: now,
                policyVersion: this.policyVersion,
              },
              {
                purpose: ConsentPurpose.PRIVACY_POLICY,
                granted: true,
                grantedAt: now,
                policyVersion: this.policyVersion,
              },
            ],
          },
        },
      });

      if (dto.role === Role.CLIENT) {
        await tx.clientOrg.create({
          data: {
            ownerUserId: created.id,
            name: dto.org_name!.trim(),
            phoneWhatsapp: dto.phone_e164,
            status: ClientOrgStatus.PENDING,
          },
        });
      } else {
        // The profile exists from signup so the questionnaire has somewhere to
        // save partial answers (B3). The signup form now captures the basics; the
        // rest is filled in the "complete your profile" steps. PROFILE_INCOMPLETE
        // until the questionnaire is done.
        const dob = dto.date_of_birth ? new Date(dto.date_of_birth) : null;
        await tx.promoterProfile.create({
          data: {
            userId: created.id,
            status: PromoterStatus.PROFILE_INCOMPLETE,
            fullName: dto.full_name?.trim() ?? null,
            gender: dto.gender ?? null,
            dob,
            age: dob ? ageFromDob(dob, now) : null,
            countryResidence: dto.country?.trim() ?? null,
            locationState: dto.state?.trim() ?? null,
            locationLga: dto.lga?.trim() ?? null,
          },
        });
      }

      return created;
    });

    await this.otp.issue(user.id, user.phoneE164, OtpPurpose.PHONE_VERIFY);

    return { user_id: user.id, status: user.status, next: 'VERIFY_PHONE' };
  }

  /**
   * Sends a phone-verification code. Always reports success: whether a number is
   * registered is not something an unauthenticated caller gets to enumerate.
   */
  async requestOtp(phone: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { phoneE164: phone } });
    if (!user) return;
    if (user.phoneVerifiedAt) return;
    await this.otp.issue(user.id, phone, OtpPurpose.PHONE_VERIFY);
  }

  async verifyOtp(phone: string, code: string, userAgent?: string): Promise<TokenPairDto> {
    const user = await this.prisma.user.findUnique({
      where: { phoneE164: phone },
      include: { roles: true },
    });
    // Generic message: a specific one would confirm which numbers exist.
    if (!user) throw new BadRequestException('That code is not valid.');

    const ok = await this.otp.verify(user.id, OtpPurpose.PHONE_VERIFY, code);
    if (!ok) throw new BadRequestException('That code is not valid.');

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        phoneVerifiedAt: new Date(),
        // The account becomes usable here. A promoter still needs to finish the
        // questionnaire and be approved — that is promoter_profiles.status, a
        // separate track from account status.
        status: user.status === UserStatus.PENDING ? UserStatus.ACTIVE : user.status,
      },
      include: { roles: true },
    });

    return this.sessions.issue(updated.id, updated.roles.map((r) => r.role), userAgent);
  }

  async login(dto: LoginDto, userAgent?: string): Promise<TokenPairDto> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { roles: true },
    });

    // Verify against a real hash even when the user is absent, so a missing
    // account and a wrong password take the same time. Otherwise this endpoint
    // enumerates accounts by latency.
    const hash = user?.passwordHash ?? (await decoyHash());
    const passwordOk = await argon2.verify(hash, dto.password).catch(() => false);

    if (!user || !passwordOk) throw new UnauthorizedException('Email or password is incorrect.');

    if (user.status === UserStatus.SUSPENDED || user.status === UserStatus.BANNED) {
      throw new ForbiddenException('This account has been suspended.');
    }
    if (!user.phoneVerifiedAt) {
      // Distinguishable so the UI can route to the OTP screen rather than
      // showing "wrong password" to someone whose password is right.
      throw new ForbiddenException({
        message: 'Verify your phone number to continue.',
        code: 'PHONE_NOT_VERIFIED',
      });
    }

    return this.sessions.issue(user.id, user.roles.map((r) => r.role), userAgent);
  }

  /**
   * Change the password of a signed-in user. Requires the current password, and
   * revokes every other session so a leaked old password can't keep a session
   * alive after the owner rotates it.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    const ok = await argon2.verify(user.passwordHash, currentPassword).catch(() => false);
    if (!ok) throw new BadRequestException('Your current password is incorrect.');

    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    await this.sessions.revokeAllForUser(userId);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true },
    });
    if (!user) throw new UnauthorizedException();

    return {
      id: user.id,
      email: user.email,
      phone_e164: user.phoneE164,
      roles: user.roles.map((r) => r.role),
      // Flattened admin capabilities, so a console can show only the actions this
      // admin may take (the backend still enforces them per-endpoint).
      capabilities: [...new Set(user.roles.flatMap((r) => r.capabilities))],
      status: user.status,
      phone_verified_at: user.phoneVerifiedAt,
    };
  }
}

/**
 * A genuine argon2 hash of a random secret, so verifying against it costs the
 * same as verifying a real password. A hand-written constant would be rejected
 * as malformed and return in microseconds — which is precisely the timing signal
 * this exists to remove.
 */
let decoyHashPromise: Promise<string> | null = null;
function decoyHash(): Promise<string> {
  decoyHashPromise ??= argon2.hash(randomBytes(32).toString('hex'));
  return decoyHashPromise;
}

/** Whole years between a date of birth and a reference date. */
function ageFromDob(dob: Date, now: Date): number {
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}
