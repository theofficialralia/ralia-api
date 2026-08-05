import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  ConsentPurpose,
  OtpPurpose,
  Platform,
  PrismaClient,
  PromoterStatus,
  Role,
  VerificationTier,
} from '@prisma/client';
import request from 'supertest';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RolesGuard } from '../../common/auth/roles.guard';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateConfigModule } from '../../common/rate-config/rate-config.module';
import { IdentityModule } from '../identity/identity.module';
import { OTP_PROVIDER, OtpProvider, OtpRecipient } from '../identity/providers/otp-provider';
import { ProfilesModule } from './profiles.module';
import { testPrisma } from '../../../test/test-db';

/**
 * B3 done-when: POST /channels returns an effective_reach the factor table
 * confirms, and a promoter reaches a matchable state.
 */

class CapturingOtpProvider implements OtpProvider {
  readonly name = 'capturing';
  readonly sent: { to: OtpRecipient; code: string }[] = [];
  async send(to: OtpRecipient, code: string, _purpose: OtpPurpose): Promise<void> {
    this.sent.push({ to, code });
  }
  last(phone: string): string {
    const found = [...this.sent].reverse().find((s) => s.to.phone === phone);
    if (!found) throw new Error(`No OTP sent to ${phone}`);
    return found.code;
  }
}

describe('profiles — questionnaire, channels, bank', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let otp: CapturingOtpProvider;
  let crypto: FieldEncryptionService;
  let token: string;
  let userId: string;

  const promoter = {
    email: 'ada@example.com',
    phone_e164: '+2348012345678',
    password: 'correct horse battery staple',
    role: Role.PROMOTER,
    accepted_terms: true,
    accepted_privacy: true,
  };

  const completeProfile = {
    full_name: 'Ada Okafor',
    dob: '1998-04-12',
    location_state: 'Lagos',
    languages_spoken: ['English', 'Igbo'],
    preferred_categories: ['Fashion', 'Tech'],
  };

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test_access_secret';
    prisma = testPrisma();
    otp = new CapturingOtpProvider();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        JwtModule.register({}),
        PrismaModule,
        CryptoModule,
        RateConfigModule,
        IdentityModule,
        ProfilesModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(OTP_PROVIDER)
      .useValue(otp)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    crypto = app.get(FieldEncryptionService);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    otp.sent.length = 0;
    await prisma.$executeRawUnsafe(
      'TRUNCATE users, user_roles, otp_codes, consents, sessions, client_orgs, promoter_profiles, channels, promoter_bank_accounts, rate_config RESTART IDENTITY CASCADE',
    );
    await prisma.rateConfig.create({ data: { isActive: true } });

    const reg = await request(app.getHttpServer()).post('/auth/register').send(promoter).expect(201);
    userId = reg.body.user_id;
    const verify = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone_e164: promoter.phone_e164, code: otp.last(promoter.phone_e164) })
      .expect(200);
    token = verify.body.access_token;
  });

  const authed = () => request(app.getHttpServer());
  const bearer = () => ({ Authorization: `Bearer ${token}` });

  // ── The done-when ────────────────────────────────────────

  it('POST /channels returns the effective_reach the factor table predicts', async () => {
    const res = await authed()
      .post('/promoters/me/channels')
      .set(bearer())
      .send({ platform: Platform.INSTAGRAM, handle: '@adastyles', claimed_audience: 10_000 })
      .expect(201);

    // 10,000 × 0.10 (instagram) × 0.6 (SELF) = 600
    expect(res.body.effective_reach).toBe(600);
    expect(res.body.verification_tier).toBe(VerificationTier.SELF);

    const stored = await prisma.channel.findUnique({ where: { id: res.body.id } });
    expect(stored!.effectiveReach).toBe(600);
  });

  it('a promoter with a complete profile and a channel reaches AWAITING_APPROVAL', async () => {
    let res = await authed().put('/promoters/me/profile').set(bearer()).send(completeProfile).expect(200);

    // Profile is filled but there is nothing to promote on yet.
    expect(res.body.status).toBe(PromoterStatus.PROFILE_INCOMPLETE);
    expect(res.body.missing).toEqual(['channels']);

    await authed()
      .post('/promoters/me/channels')
      .set(bearer())
      .send({ platform: Platform.WHATSAPP_STATUS, claimed_audience: 800 })
      .expect(201);

    res = await authed().get('/promoters/me/profile').set(bearer()).expect(200);
    expect(res.body.complete).toBe(true);
    expect(res.body.missing).toEqual([]);
    expect(res.body.status).toBe(PromoterStatus.AWAITING_APPROVAL);

    // Everything §5.3's filter reads is now present.
    expect(res.body.age).toBeGreaterThan(0);
    expect(res.body.location_state).toBe('Lagos');
    expect(res.body.languages_spoken).toContain('English');
    expect(res.body.max_campaigns_per_week).toBeGreaterThan(0);
    expect(res.body.trust_score).toBeGreaterThan(0);
  });

  // ── Partial save ─────────────────────────────────────────

  it('saves partially and resumes without losing earlier answers', async () => {
    await authed().put('/promoters/me/profile').set(bearer()).send({ full_name: 'Ada Okafor' }).expect(200);
    await authed().put('/promoters/me/profile').set(bearer()).send({ location_state: 'Lagos' }).expect(200);
    const res = await authed()
      .put('/promoters/me/profile')
      .set(bearer())
      .send({ languages_spoken: ['English'] })
      .expect(200);

    expect(res.body.full_name).toBe('Ada Okafor');
    expect(res.body.location_state).toBe('Lagos');
    expect(res.body.languages_spoken).toEqual(['English']);
    expect(res.body.missing.sort()).toEqual(['channels', 'dob', 'preferred_categories']);
  });

  it('an omitted field is left alone, not cleared', async () => {
    await authed().put('/promoters/me/profile').set(bearer()).send(completeProfile).expect(200);
    const res = await authed()
      .put('/promoters/me/profile')
      .set(bearer())
      .send({ max_campaigns_per_week: 5 })
      .expect(200);

    expect(res.body.full_name).toBe('Ada Okafor');
    expect(res.body.location_state).toBe('Lagos');
    expect(res.body.max_campaigns_per_week).toBe(5);
  });

  // ── Capability inputs (§3) ───────────────────────────────

  it('stores roles and self-reported capability factors', async () => {
    const res = await authed()
      .put('/promoters/me/profile')
      .set(bearer())
      .send({ roles: ['DISTRIBUTOR', 'CREATOR'], capability_inputs: { postingFrequency: 0.7, equipment: 0.5 } })
      .expect(200);

    expect(res.body.roles).toEqual(['DISTRIBUTOR', 'CREATOR']);
    expect(res.body.capability_inputs).toEqual({ postingFrequency: 0.7, equipment: 0.5 });
    expect(res.body.capability_scores).toBeNull(); // computed only at admin review
  });

  it('rejects an unknown capability factor or an out-of-range value', async () => {
    await authed().put('/promoters/me/profile').set(bearer()).send({ capability_inputs: { bogus: 0.5 } }).expect(400);
    await authed().put('/promoters/me/profile').set(bearer()).send({ capability_inputs: { postingFrequency: 1.5 } }).expect(400);
  });

  // ── Derived and protected fields ─────────────────────────

  it('derives age from dob and refuses a client-supplied age or trust_score', async () => {
    const res = await authed()
      .put('/promoters/me/profile')
      .set(bearer())
      .send({ dob: '1998-04-12' })
      .expect(200);

    const expected = new Date().getUTCFullYear() - 1998 - (new Date() < new Date(`${new Date().getUTCFullYear()}-04-12`) ? 1 : 0);
    expect(res.body.age).toBe(expected);

    // whitelist + forbidNonWhitelisted means these are rejected outright rather
    // than silently ignored.
    await authed().put('/promoters/me/profile').set(bearer()).send({ age: 21 }).expect(400);
    await authed().put('/promoters/me/profile').set(bearer()).send({ trust_score: 99 }).expect(400);
  });

  it('refuses a client-set verification_tier or effective_reach', async () => {
    await authed()
      .post('/promoters/me/channels')
      .set(bearer())
      .send({ platform: Platform.INSTAGRAM, claimed_audience: 10_000, verification_tier: 'INSIGHTS' })
      .expect(400);

    await authed()
      .post('/promoters/me/channels')
      .set(bearer())
      .send({ platform: Platform.INSTAGRAM, claimed_audience: 10_000, effective_reach: 999_999 })
      .expect(400);
  });

  it('reads its factors from rate_config, not the code defaults', async () => {
    // Halve the Instagram factor; the next channel must price on the new number.
    await prisma.rateConfig.updateMany({ where: { isActive: true }, data: { factorInstagram: 0.05 } });

    const res = await authed()
      .post('/promoters/me/channels')
      .set(bearer())
      .send({ platform: Platform.INSTAGRAM, claimed_audience: 10_000 })
      .expect(201);

    // 10,000 × 0.05 × 0.6 = 300, versus 600 on the default factor.
    expect(res.body.effective_reach).toBe(300);
  });

  // ── Consent ──────────────────────────────────────────────

  it('records consent where the sensitive field is collected', async () => {
    await authed().put('/promoters/me/profile').set(bearer()).send({ dob: '1998-04-12' }).expect(200);

    let consents = await prisma.consent.findMany({ where: { userId } });
    expect(consents.map((c) => c.purpose)).toContain(ConsentPurpose.DATA_DOB);
    expect(consents.map((c) => c.purpose)).not.toContain(ConsentPurpose.DATA_GENDER);

    await authed().put('/promoters/me/profile').set(bearer()).send({ gender: 'FEMALE' }).expect(200);
    consents = await prisma.consent.findMany({ where: { userId } });
    expect(consents.map((c) => c.purpose)).toContain(ConsentPurpose.DATA_GENDER);

    const dobConsent = consents.find((c) => c.purpose === ConsentPurpose.DATA_DOB)!;
    expect(dobConsent.granted).toBe(true);
    expect(dobConsent.grantedAt).not.toBeNull();
    expect(dobConsent.policyVersion).toBeTruthy();
  });

  it('does not duplicate a consent row when the field is saved twice', async () => {
    await authed().put('/promoters/me/profile').set(bearer()).send({ dob: '1998-04-12' }).expect(200);
    await authed().put('/promoters/me/profile').set(bearer()).send({ dob: '1997-01-01' }).expect(200);

    const rows = await prisma.consent.findMany({ where: { userId, purpose: ConsentPurpose.DATA_DOB } });
    expect(rows).toHaveLength(1);
  });

  // ── Status transitions ───────────────────────────────────

  it('does not drag an already-approved promoter back into the queue on edit', async () => {
    await authed().put('/promoters/me/profile').set(bearer()).send(completeProfile).expect(200);
    await authed()
      .post('/promoters/me/channels')
      .set(bearer())
      .send({ platform: Platform.WHATSAPP_STATUS, claimed_audience: 800 })
      .expect(201);

    await prisma.promoterProfile.update({ where: { userId }, data: { status: PromoterStatus.ACTIVE } });

    const res = await authed()
      .put('/promoters/me/profile')
      .set(bearer())
      .send({ location_state: 'Kano' })
      .expect(200);
    expect(res.body.status).toBe(PromoterStatus.ACTIVE);
  });

  it('does not resurrect a rejected promoter on edit', async () => {
    await authed().put('/promoters/me/profile').set(bearer()).send(completeProfile).expect(200);
    await authed()
      .post('/promoters/me/channels')
      .set(bearer())
      .send({ platform: Platform.WHATSAPP_STATUS, claimed_audience: 800 })
      .expect(201);
    await prisma.promoterProfile.update({ where: { userId }, data: { status: PromoterStatus.REJECTED } });

    const res = await authed().put('/promoters/me/profile').set(bearer()).send({ location_state: 'Kano' }).expect(200);
    expect(res.body.status).toBe(PromoterStatus.REJECTED);
  });

  // ── Channels ─────────────────────────────────────────────

  it('lists and deletes only the caller’s own channels', async () => {
    const mine = await authed()
      .post('/promoters/me/channels')
      .set(bearer())
      .send({ platform: Platform.TIKTOK, claimed_audience: 5000 })
      .expect(201);

    expect((await authed().get('/promoters/me/channels').set(bearer()).expect(200)).body).toHaveLength(1);

    // Someone else's channel is a 404, not a 403 — a 403 confirms the id exists.
    const other = await prisma.user.create({
      data: { email: 'other@example.com', phoneE164: '+2348099999999', passwordHash: 'x' },
    });
    const theirs = await prisma.channel.create({
      data: { promoterId: other.id, platform: Platform.X, claimedAudience: 100, effectiveReach: 3 },
    });
    await authed().delete(`/promoters/me/channels/${theirs.id}`).set(bearer()).expect(404);

    await authed().delete(`/promoters/me/channels/${mine.body.id}`).set(bearer()).expect(204);
    expect((await authed().get('/promoters/me/channels').set(bearer()).expect(200)).body).toHaveLength(0);
  });

  it('refuses to delete a frozen channel', async () => {
    const res = await authed()
      .post('/promoters/me/channels')
      .set(bearer())
      .send({ platform: Platform.TIKTOK, claimed_audience: 5000 })
      .expect(201);
    await prisma.channel.update({ where: { id: res.body.id }, data: { adminFrozen: true } });

    await authed().delete(`/promoters/me/channels/${res.body.id}`).set(bearer()).expect(403);
  });

  it('validates group channels', async () => {
    await authed()
      .post('/promoters/me/channels')
      .set(bearer())
      .send({ platform: Platform.WHATSAPP_GROUP, claimed_audience: 500, is_group: true })
      .expect(400);

    await authed()
      .post('/promoters/me/channels')
      .set(bearer())
      .send({
        platform: Platform.WHATSAPP_GROUP,
        claimed_audience: 500,
        is_group: true,
        group_members: 500,
        active_participants: 900,
      })
      .expect(400);
  });

  // ── Bank ─────────────────────────────────────────────────

  it('encrypts the account number and never returns it in full', async () => {
    const accountNumber = '0123456789';
    const res = await authed()
      .post('/promoters/me/bank')
      .set(bearer())
      .send({ bank_code: '058', account_number: accountNumber, account_name: 'ADA OKAFOR' })
      .expect(201);

    expect(res.body.account_number_masked).toBe('******6789');
    expect(JSON.stringify(res.body)).not.toContain(accountNumber);

    const stored = await prisma.promoterBankAccount.findUnique({ where: { id: res.body.id } });
    // The column holds ciphertext, not the number.
    expect(stored!.accountNumberEnc).not.toContain(accountNumber);
    expect(stored!.accountNumberEnc.startsWith('v1.')).toBe(true);
    // …and it round-trips.
    expect(crypto.decrypt(stored!.accountNumberEnc)).toBe(accountNumber);
  });

  it('rejects a malformed NUBAN or bank code', async () => {
    await authed()
      .post('/promoters/me/bank')
      .set(bearer())
      .send({ bank_code: '058', account_number: '12345', account_name: 'ADA' })
      .expect(400);
    await authed()
      .post('/promoters/me/bank')
      .set(bearer())
      .send({ bank_code: 'GTB', account_number: '0123456789', account_name: 'ADA' })
      .expect(400);
  });

  it('keeps exactly one default when a second account is added', async () => {
    await authed()
      .post('/promoters/me/bank')
      .set(bearer())
      .send({ bank_code: '058', account_number: '0123456789', account_name: 'ADA OKAFOR' })
      .expect(201);
    await authed()
      .post('/promoters/me/bank')
      .set(bearer())
      .send({ bank_code: '044', account_number: '9876543210', account_name: 'ADA OKAFOR' })
      .expect(201);

    const defaults = await prisma.promoterBankAccount.count({ where: { userId, isDefault: true } });
    expect(defaults).toBe(1);
  });

  // ── Access control ───────────────────────────────────────

  it('requires authentication', async () => {
    await authed().get('/promoters/me/profile').expect(401);
    await authed().post('/promoters/me/channels').send({ platform: Platform.X, claimed_audience: 1 }).expect(401);
  });

  it('refuses a client account', async () => {
    const reg = await authed()
      .post('/auth/register')
      .send({
        email: 'biz@example.com',
        phone_e164: '+2348087654321',
        password: 'another long passphrase',
        role: Role.CLIENT,
        org_name: 'Naija Threads',
        accepted_terms: true,
        accepted_privacy: true,
      })
      .expect(201);
    const verify = await authed()
      .post('/auth/otp/verify')
      .send({ phone_e164: '+2348087654321', code: otp.last('+2348087654321') })
      .expect(200);

    await authed()
      .get('/promoters/me/profile')
      .set({ Authorization: `Bearer ${verify.body.access_token}` })
      .expect(403);
    expect(reg.body.user_id).toBeDefined();
  });
});
