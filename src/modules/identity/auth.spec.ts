import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConsentPurpose, OtpPurpose, PrismaClient, PromoterStatus, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RolesGuard } from '../../common/auth/roles.guard';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IdentityModule } from './identity.module';
import { OTP_PROVIDER, OtpProvider, OtpRecipient } from './providers/otp-provider';
import { testPrisma } from '../../../test/test-db';

/**
 * B2 done-when: both account types register, verify OTP, log in and reach an
 * authed endpoint, with a consent row per purpose.
 */

/** Captures the code instead of sending it, so tests can read it. */
class CapturingOtpProvider implements OtpProvider {
  readonly name = 'capturing';
  readonly sent: { to: OtpRecipient; code: string; purpose: OtpPurpose }[] = [];
  async send(to: OtpRecipient, code: string, purpose: OtpPurpose): Promise<void> {
    this.sent.push({ to, code, purpose });
  }
  last(phone: string): string {
    const found = [...this.sent].reverse().find((s) => s.to.phone === phone);
    if (!found) throw new Error(`No OTP was sent to ${phone}`);
    return found.code;
  }
}

describe('identity — auth', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let otp: CapturingOtpProvider;

  const promoter = {
    email: 'ada@example.com',
    phone_e164: '+2348012345678',
    password: 'correct horse battery staple',
    role: Role.PROMOTER,
    accepted_terms: true,
    accepted_privacy: true,
  };

  const client = {
    email: 'biz@example.com',
    phone_e164: '+2348087654321',
    password: 'another long enough passphrase',
    role: Role.CLIENT,
    org_name: 'Naija Threads',
    accepted_terms: true,
    accepted_privacy: true,
  };

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test_access_secret';
    process.env.JWT_REFRESH_SECRET ??= 'test_refresh_secret';
    prisma = testPrisma();
    otp = new CapturingOtpProvider();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({}), PrismaModule, IdentityModule],
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
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    otp.sent.length = 0;
    await prisma.$executeRawUnsafe(
      'TRUNCATE users, user_roles, otp_codes, consents, sessions, client_orgs, promoter_profiles RESTART IDENTITY CASCADE',
    );
  });

  const http = () => request(app.getHttpServer());

  async function registerAndVerify(who: typeof promoter | typeof client) {
    await http().post('/auth/register').send(who).expect(201);
    const code = otp.last(who.phone_e164);
    const res = await http()
      .post('/auth/otp/verify')
      .send({ phone_e164: who.phone_e164, code })
      .expect(200);
    return res.body as { access_token: string; refresh_token: string };
  }

  // ── The done-when ────────────────────────────────────────

  it('a promoter registers, verifies, logs in and reaches an authed endpoint', async () => {
    const res = await http().post('/auth/register').send(promoter).expect(201);
    expect(res.body).toMatchObject({ status: UserStatus.PENDING, next: 'VERIFY_PHONE' });

    // A promoter profile exists from signup so the questionnaire has somewhere to save.
    const profile = await prisma.promoterProfile.findUnique({ where: { userId: res.body.user_id } });
    expect(profile?.status).toBe(PromoterStatus.PROFILE_INCOMPLETE);

    const code = otp.last(promoter.phone_e164);
    expect(code).toMatch(/^\d{6}$/);

    const tokens = await http()
      .post('/auth/otp/verify')
      .send({ phone_e164: promoter.phone_e164, code })
      .expect(200);
    expect(tokens.body.access_token).toBeDefined();

    // Account is now usable; promoter approval is a separate track.
    const user = await prisma.user.findUnique({ where: { email: promoter.email } });
    expect(user?.status).toBe(UserStatus.ACTIVE);
    expect(user?.phoneVerifiedAt).not.toBeNull();

    const login = await http()
      .post('/auth/login')
      .send({ email: promoter.email, password: promoter.password })
      .expect(200);

    const me = await http()
      .get('/auth/me')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .expect(200);
    expect(me.body).toMatchObject({ email: promoter.email, roles: [Role.PROMOTER], status: UserStatus.ACTIVE });
  });

  it('a client registers with an org and reaches an authed endpoint', async () => {
    const tokens = await registerAndVerify(client);
    const me = await http().get('/auth/me').set('Authorization', `Bearer ${tokens.access_token}`).expect(200);
    expect(me.body.roles).toEqual([Role.CLIENT]);

    const org = await prisma.clientOrg.findFirst({ where: { name: client.org_name } });
    expect(org).not.toBeNull();
  });

  it('records a consent row per purpose at signup', async () => {
    const res = await http().post('/auth/register').send(promoter).expect(201);
    const consents = await prisma.consent.findMany({ where: { userId: res.body.user_id } });

    const purposes = consents.map((c) => c.purpose).sort();
    expect(purposes).toEqual([ConsentPurpose.PRIVACY_POLICY, ConsentPurpose.TERMS_OF_SERVICE].sort());
    for (const c of consents) {
      expect(c.granted).toBe(true);
      expect(c.grantedAt).not.toBeNull();
      expect(c.policyVersion).toBeTruthy();
    }
  });

  // ── Registration guards ──────────────────────────────────

  it('rejects a client without an org name', async () => {
    await http().post('/auth/register').send({ ...client, org_name: undefined }).expect(400);
  });

  it('rejects registration without both consents', async () => {
    await http().post('/auth/register').send({ ...promoter, accepted_privacy: false }).expect(400);
  });

  it('rejects a duplicate email or phone', async () => {
    await http().post('/auth/register').send(promoter).expect(201);
    await http().post('/auth/register').send({ ...promoter, phone_e164: '+2348011111111' }).expect(409);
    await http().post('/auth/register').send({ ...promoter, email: 'other@example.com' }).expect(409);
  });

  it('rejects a malformed phone and a short password', async () => {
    await http().post('/auth/register').send({ ...promoter, phone_e164: '08012345678' }).expect(400);
    await http().post('/auth/register').send({ ...promoter, password: 'short' }).expect(400);
  });

  it('never persists the password itself', async () => {
    const res = await http().post('/auth/register').send(promoter).expect(201);
    const user = await prisma.user.findUnique({ where: { id: res.body.user_id } });
    expect(user!.passwordHash).not.toContain(promoter.password);
    expect(user!.passwordHash.startsWith('$argon2')).toBe(true);
  });

  // ── OTP ──────────────────────────────────────────────────

  it('only the newest code works', async () => {
    await http().post('/auth/register').send(promoter).expect(201);
    const first = otp.last(promoter.phone_e164);

    await http().post('/auth/otp/request').send({ phone_e164: promoter.phone_e164 }).expect(202);
    const second = otp.last(promoter.phone_e164);
    expect(second).not.toBe(first);

    await http().post('/auth/otp/verify').send({ phone_e164: promoter.phone_e164, code: first }).expect(400);
    await http().post('/auth/otp/verify').send({ phone_e164: promoter.phone_e164, code: second }).expect(200);
  });

  it('a code cannot be replayed once consumed', async () => {
    await http().post('/auth/register').send(promoter).expect(201);
    const code = otp.last(promoter.phone_e164);
    await http().post('/auth/otp/verify').send({ phone_e164: promoter.phone_e164, code }).expect(200);
    await http().post('/auth/otp/verify').send({ phone_e164: promoter.phone_e164, code }).expect(400);
  });

  it('an expired code is refused', async () => {
    const res = await http().post('/auth/register').send(promoter).expect(201);
    const code = otp.last(promoter.phone_e164);
    await prisma.otpCode.updateMany({
      where: { userId: res.body.user_id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await http().post('/auth/otp/verify').send({ phone_e164: promoter.phone_e164, code }).expect(400);
  });

  it('stops guessing after five wrong attempts', async () => {
    await http().post('/auth/register').send(promoter).expect(201);
    const real = otp.last(promoter.phone_e164);
    const wrong = real === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) {
      await http().post('/auth/otp/verify').send({ phone_e164: promoter.phone_e164, code: wrong }).expect(400);
    }
    // Even the correct code is refused now — the attempt budget is spent.
    await http().post('/auth/otp/verify').send({ phone_e164: promoter.phone_e164, code: real }).expect(400);
  });

  it('does not reveal whether a phone is registered', async () => {
    const res = await http()
      .post('/auth/otp/request')
      .send({ phone_e164: '+2349999999999' })
      .expect(202);
    expect(res.body.accepted).toBe(true);
    expect(otp.sent).toHaveLength(0);
  });

  // ── Login ────────────────────────────────────────────────

  it('refuses login before the phone is verified, distinguishably', async () => {
    await http().post('/auth/register').send(promoter).expect(201);
    const res = await http()
      .post('/auth/login')
      .send({ email: promoter.email, password: promoter.password })
      .expect(403);
    expect(res.body.code).toBe('PHONE_NOT_VERIFIED');
  });

  it('refuses a wrong password and an unknown email identically', async () => {
    await registerAndVerify(promoter);
    const wrongPassword = await http()
      .post('/auth/login')
      .send({ email: promoter.email, password: 'not the password' })
      .expect(401);
    const unknownEmail = await http()
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'not the password' })
      .expect(401);
    expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
  });

  it('refuses a suspended account', async () => {
    await registerAndVerify(promoter);
    await prisma.user.update({ where: { email: promoter.email }, data: { status: UserStatus.SUSPENDED } });
    await http().post('/auth/login').send({ email: promoter.email, password: promoter.password }).expect(403);
  });

  it('suspension takes effect on an already-issued token', async () => {
    const tokens = await registerAndVerify(promoter);
    await http().get('/auth/me').set('Authorization', `Bearer ${tokens.access_token}`).expect(200);

    await prisma.user.update({ where: { email: promoter.email }, data: { status: UserStatus.SUSPENDED } });

    // The token is still cryptographically valid; the guard reads the user, so
    // suspension bites now rather than whenever the token happens to expire.
    await http().get('/auth/me').set('Authorization', `Bearer ${tokens.access_token}`).expect(403);
  });

  // ── Sessions ─────────────────────────────────────────────

  it('requires a bearer token on an authed endpoint', async () => {
    await http().get('/auth/me').expect(401);
    await http().get('/auth/me').set('Authorization', 'Bearer nonsense').expect(401);
  });

  it('refresh rotates the pair and revokes the old token', async () => {
    const tokens = await registerAndVerify(promoter);

    const refreshed = await http().post('/auth/refresh').send({ refresh_token: tokens.refresh_token }).expect(200);
    expect(refreshed.body.refresh_token).not.toBe(tokens.refresh_token);

    const fresh = refreshed.body.refresh_token;
    await http().get('/auth/me').set('Authorization', `Bearer ${refreshed.body.access_token}`).expect(200);
    await http().post('/auth/refresh').send({ refresh_token: fresh }).expect(200);
  });

  it('replaying a revoked refresh token kills every session for that user', async () => {
    const first = await registerAndVerify(promoter);
    const second = await http().post('/auth/refresh').send({ refresh_token: first.refresh_token }).expect(200);

    // first.refresh_token is now revoked. Presenting it means it leaked.
    await http().post('/auth/refresh').send({ refresh_token: first.refresh_token }).expect(401);

    // The attacker's replay burned the legitimate holder's session too — the
    // safe direction to fail.
    await http().post('/auth/refresh').send({ refresh_token: second.body.refresh_token }).expect(401);

    const live = await prisma.session.count({
      where: { user: { email: promoter.email }, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it('logout revokes the refresh token', async () => {
    const tokens = await registerAndVerify(promoter);
    await http().post('/auth/logout').send({ refresh_token: tokens.refresh_token }).expect(204);
    await http().post('/auth/refresh').send({ refresh_token: tokens.refresh_token }).expect(401);
  });

  it('logout with an unknown token is a no-op, not an error', async () => {
    await http().post('/auth/logout').send({ refresh_token: 'never-issued' }).expect(204);
  });

  // ── Change password ──────────────────────────────────────

  it('changes the password with the correct current one, and lets the user log in with the new one', async () => {
    const tokens = await registerAndVerify(promoter);
    await http()
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .send({ current_password: promoter.password, new_password: 'a brand new passphrase' })
      .expect(204);

    await http().post('/auth/login').send({ email: promoter.email, password: promoter.password }).expect(401);
    await http().post('/auth/login').send({ email: promoter.email, password: 'a brand new passphrase' }).expect(200);
  });

  it('rejects a wrong current password and a too-short new one', async () => {
    const tokens = await registerAndVerify(promoter);
    const auth = { Authorization: `Bearer ${tokens.access_token}` };
    await http().post('/auth/change-password').set(auth).send({ current_password: 'wrong', new_password: 'a long enough one' }).expect(400);
    await http().post('/auth/change-password').set(auth).send({ current_password: promoter.password, new_password: 'short' }).expect(400);
  });

  it('revokes other sessions when the password changes', async () => {
    const tokens = await registerAndVerify(promoter);
    await http()
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .send({ current_password: promoter.password, new_password: 'a brand new passphrase' })
      .expect(204);
    // The refresh token issued before the change is now revoked.
    await http().post('/auth/refresh').send({ refresh_token: tokens.refresh_token }).expect(401);
  });

  it('change-password requires authentication', async () => {
    await http().post('/auth/change-password').send({ current_password: 'x', new_password: 'a long enough one' }).expect(401);
  });
});
