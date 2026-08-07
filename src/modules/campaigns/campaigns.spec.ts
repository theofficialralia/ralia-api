import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  CampaignObjective,
  CampaignStatus,
  ChannelStatus,
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
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateConfigModule } from '../../common/rate-config/rate-config.module';
import { StorageModule } from '../../common/storage/storage.module';
import { IdentityModule } from '../identity/identity.module';
import { OTP_PROVIDER, OtpProvider, OtpRecipient } from '../identity/providers/otp-provider';
import { computeEffectiveReach } from '../../common/reach/effective-reach';
import { CampaignsModule } from './campaigns.module';
import { testPrisma } from '../../../test/test-db';

class CapturingOtpProvider implements OtpProvider {
  readonly name = 'capturing';
  readonly sent: { to: OtpRecipient; code: string }[] = [];
  async send(to: OtpRecipient, code: string, _p: OtpPurpose): Promise<void> {
    this.sent.push({ to, code });
  }
  last(phone: string): string {
    const f = [...this.sent].reverse().find((s) => s.to.phone === phone);
    if (!f) throw new Error(`no OTP to ${phone}`);
    return f.code;
  }
}

describe('campaigns — draft, targeting, pricing', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let otp: CapturingOtpProvider;
  let clientToken: string;

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
        StorageModule,
        IdentityModule,
        CampaignsModule,
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
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const http = () => request(app.getHttpServer());

  async function registerClient(): Promise<string> {
    const phone = '+2348010000001';
    await http()
      .post('/auth/register')
      .send({
        email: 'biz@example.com', phone_e164: phone, password: 'a long enough passphrase',
        role: Role.CLIENT, org_name: 'Naija Threads', accepted_terms: true, accepted_privacy: true,
      })
      .expect(201);
    const verify = await http()
      .post('/auth/otp/verify')
      .send({ phone_e164: phone, code: otp.last(phone) })
      .expect(200);
    return verify.body.access_token;
  }

  /** A pool of eligible promoters so the quote estimate is non-zero. */
  let promoterSeq = 0;
  async function seedPromoters(n: number, opts: { state?: string; platform?: Platform; claimed?: number } = {}) {
    const platform = opts.platform ?? Platform.INSTAGRAM;
    const claimed = opts.claimed ?? 20_000;
    for (let i = 0; i < n; i++) {
      const seq = promoterSeq++;
      const user = await prisma.user.create({
        data: {
          email: `p${seq}@example.com`, phoneE164: `+23481${String(20000000 + seq).padStart(8, '0')}`,
          passwordHash: 'x', status: 'ACTIVE', phoneVerifiedAt: new Date(),
          roles: { create: { role: Role.PROMOTER } },
        },
      });
      await prisma.promoterProfile.create({
        data: {
          userId: user.id, status: PromoterStatus.ACTIVE, age: 25,
          locationState: opts.state ?? 'Lagos', languagesSpoken: ['English'],
          preferredCategories: ['Fashion'], trustScore: 60,
        },
      });
      await prisma.channel.create({
        data: {
          promoterId: user.id, platform, claimedAudience: claimed,
          verificationTier: VerificationTier.SCREENSHOT,
          effectiveReach: computeEffectiveReach(claimed, platform, VerificationTier.SCREENSHOT),
          status: ChannelStatus.ACTIVE,
        },
      });
    }
  }

  beforeEach(async () => {
    otp.sent.length = 0;
    await prisma.$executeRawUnsafe(
      'TRUNCATE users, user_roles, otp_codes, consents, sessions, client_orgs, promoter_profiles, channels, campaigns, campaign_targeting, campaign_assets, campaign_slots, rate_config RESTART IDENTITY CASCADE',
    );
    await prisma.rateConfig.create({ data: { isActive: true } });
    clientToken = await registerClient();
  });

  const auth = () => ({ Authorization: `Bearer ${clientToken}` });

  async function createDraft(overrides: Record<string, unknown> = {}): Promise<string> {
    const res = await http()
      .post('/campaigns')
      .set(auth())
      .send({
        name: 'Harmattan Drop', objective: CampaignObjective.AWARENESS,
        destination_url: 'https://naijathreads.example/shop', slots_total: 12, ...overrides,
      })
      .expect(201);
    return res.body.id;
  }

  // ── Lifecycle ────────────────────────────────────────────

  it('creates a draft with an empty targeting row', async () => {
    const id = await createDraft();
    const res = await http().get(`/campaigns/${id}`).set(auth()).expect(200);
    expect(res.body.status).toBe(CampaignStatus.DRAFT);
    expect(res.body.price).toBeNull();
    expect(res.body.slots_total).toBe(12);
  });

  // ── The done-when: deterministic quote ───────────────────

  it('quotes deterministically and freezes the price', async () => {
    await seedPromoters(5);
    const id = await createDraft({ objective: CampaignObjective.AWARENESS, slots_total: 10 });
    await http().put(`/campaigns/${id}/targeting`).set(auth())
      .send({ states: ['Lagos'], platforms: ['INSTAGRAM'], min_effective_reach: 1000 })
      .expect(200);

    const q = await http().post(`/campaigns/${id}/quote`).set(auth()).expect(201);

    // reach basis 1000, awareness 1.0, 3 active filters (states, platforms, minReach)
    // → targeting_mult 1.15. Distribution slot (default role) → RPM 300,000/1,000.
    // unit = (1000/1000)×300000×1.0×1.15 = 345000. ×10 = 3,450,000 (≥ ₦15k floor).
    expect(q.body.active_filters).toBe(3);
    expect(q.body.unit_price.amount_minor).toBe(345000);
    expect(q.body.price.amount_minor).toBe(3450000);
    // promoter keeps 50%: round(345000 × 0.5) = 172500
    expect(q.body.promoter_fee.amount_minor).toBe(172500);
    expect(q.body.eligible_promoters).toBe(5);
    expect(q.body.estimated_reach).toBeGreaterThan(0);

    const after = await http().get(`/campaigns/${id}`).set(auth()).expect(200);
    expect(after.body.status).toBe(CampaignStatus.QUOTED);
    expect(after.body.price.amount_minor).toBe(3450000);
    expect(after.body.quoted_at).not.toBeNull();
  });

  it('plans budget↔reach without persisting anything', async () => {
    const id = await createDraft({ objective: CampaignObjective.AWARENESS, slots_total: 10 });
    await http().put(`/campaigns/${id}/targeting`).set(auth())
      .send({ states: ['Lagos'], platforms: ['INSTAGRAM'], min_effective_reach: 1000 })
      .expect(200);

    // unit = 345000 (as above). Budget 2,000,000 → floor(2000000/345000) = 5 slots, reach 5×1000.
    const byBudget = await http().post(`/campaigns/${id}/plan`).set(auth()).send({ budget_minor: 2000000 }).expect(200);
    expect(byBudget.body.unit_price.amount_minor).toBe(345000);
    expect(byBudget.body.slots).toBe(5);
    expect(byBudget.body.total_price.amount_minor).toBe(1725000);
    expect(byBudget.body.estimated_total_reach).toBe(5000);
    // Distribution floor surfaced for the slider: ₦15,000 = 1,500,000 kobo,
    // ceil(1,500,000 / 345,000) = 5 slots. This plan (5 slots) meets it.
    expect(byBudget.body.category).toBe('DISTRIBUTION');
    expect(byBudget.body.floor_minor.amount_minor).toBe(1500000);
    expect(byBudget.body.min_slots).toBe(5);
    expect(byBudget.body.meets_floor).toBe(true);
    expect(byBudget.body.default_promoters).toBe(5);
    expect(byBudget.body.default_reach_per_slot).toBe(1000);

    // Driving by slots prices them directly.
    const bySlots = await http().post(`/campaigns/${id}/plan`).set(auth()).send({ slots: 8 }).expect(200);
    expect(bySlots.body.total_price.amount_minor).toBe(2760000);
    expect(bySlots.body.estimated_total_reach).toBe(8000);

    // The preview persisted nothing: the campaign is still an unpriced DRAFT.
    const after = await http().get(`/campaigns/${id}`).set(auth()).expect(200);
    expect(after.body.status).toBe(CampaignStatus.DRAFT);
    expect(after.body.price).toBeNull();
  });

  it('a rate_config change never reprices a quoted campaign', async () => {
    await seedPromoters(3);
    const id = await createDraft({ slots_total: 5 });
    await http().put(`/campaigns/${id}/targeting`).set(auth())
      .send({ min_effective_reach: 1000 }).expect(200);
    const q1 = await http().post(`/campaigns/${id}/quote`).set(auth()).expect(201);
    const originalPrice = q1.body.price.amount_minor;

    // Double the (Distribution) RPM. The stored price must not move.
    await prisma.rateConfig.updateMany({ where: { isActive: true }, data: { rpmDistributionMinor: 600000 } });

    const after = await http().get(`/campaigns/${id}`).set(auth()).expect(200);
    expect(after.body.price.amount_minor).toBe(originalPrice);
  });

  it('editing a quoted campaign returns it to DRAFT and clears the price', async () => {
    const id = await createDraft();
    await http().put(`/campaigns/${id}/targeting`).set(auth()).send({ min_effective_reach: 1000 }).expect(200);
    await http().post(`/campaigns/${id}/quote`).set(auth()).expect(201);

    const edited = await http().patch(`/campaigns/${id}`).set(auth()).send({ slots_total: 20 }).expect(200);
    expect(edited.body.status).toBe(CampaignStatus.DRAFT);
    expect(edited.body.price).toBeNull();
  });

  it('re-targeting a quoted campaign invalidates the quote', async () => {
    const id = await createDraft();
    await http().put(`/campaigns/${id}/targeting`).set(auth()).send({ min_effective_reach: 1000 }).expect(200);
    await http().post(`/campaigns/${id}/quote`).set(auth()).expect(201);

    const retargeted = await http().put(`/campaigns/${id}/targeting`).set(auth())
      .send({ min_effective_reach: 2000 }).expect(200);
    expect(retargeted.body.status).toBe(CampaignStatus.DRAFT);
    expect(retargeted.body.price).toBeNull();
  });

  it('refuses a quote with no minimum effective reach', async () => {
    const id = await createDraft();
    await http().post(`/campaigns/${id}/quote`).set(auth()).expect(400);
  });

  it('moves a quoted campaign to PENDING_APPROVAL on submit', async () => {
    const id = await createDraft();
    await http().put(`/campaigns/${id}/targeting`).set(auth()).send({ min_effective_reach: 1000 }).expect(200);
    await http().post(`/campaigns/${id}/quote`).set(auth()).expect(201);
    const res = await http().post(`/campaigns/${id}/submit`).set(auth()).expect(201);
    expect(res.body.status).toBe(CampaignStatus.PENDING_APPROVAL);

    // A pending campaign is no longer editable.
    await http().patch(`/campaigns/${id}`).set(auth()).send({ name: 'x' }).expect(400);
  });

  it('cannot submit a campaign that was never quoted', async () => {
    const id = await createDraft();
    await http().post(`/campaigns/${id}/submit`).set(auth()).expect(400);
  });

  // ── Estimate reflects targeting ──────────────────────────

  it('the eligible estimate narrows as targeting tightens', async () => {
    await seedPromoters(4, { state: 'Lagos', platform: Platform.INSTAGRAM });
    await seedPromoters(3, { state: 'Kano', platform: Platform.INSTAGRAM });
    const id = await createDraft();

    await http().put(`/campaigns/${id}/targeting`).set(auth())
      .send({ platforms: ['INSTAGRAM'], min_effective_reach: 500 }).expect(200);
    const all = await http().post(`/campaigns/${id}/quote`).set(auth()).expect(201);
    expect(all.body.eligible_promoters).toBe(7);

    await http().put(`/campaigns/${id}/targeting`).set(auth())
      .send({ states: ['Lagos'], platforms: ['INSTAGRAM'], min_effective_reach: 500 }).expect(200);
    const lagos = await http().post(`/campaigns/${id}/quote`).set(auth()).expect(201);
    expect(lagos.body.eligible_promoters).toBe(4);
  });

  // ── Ownership & access ───────────────────────────────────

  it('a promoter cannot touch campaign endpoints', async () => {
    const phone = '+2348055555555';
    await http().post('/auth/register').send({
      email: 'ada@example.com', phone_e164: phone, password: 'a long enough passphrase',
      role: Role.PROMOTER, accepted_terms: true, accepted_privacy: true,
    }).expect(201);
    const v = await http().post('/auth/otp/verify').send({ phone_e164: phone, code: otp.last(phone) }).expect(200);
    await http().get('/campaigns').set({ Authorization: `Bearer ${v.body.access_token}` }).expect(403);
  });

  it('a client cannot see another org’s campaign', async () => {
    const id = await createDraft();

    // Second client.
    const phone = '+2348010000002';
    await http().post('/auth/register').send({
      email: 'biz2@example.com', phone_e164: phone, password: 'a long enough passphrase',
      role: Role.CLIENT, org_name: 'PayFlow', accepted_terms: true, accepted_privacy: true,
    }).expect(201);
    const v = await http().post('/auth/otp/verify').send({ phone_e164: phone, code: otp.last(phone) }).expect(200);

    await http().get(`/campaigns/${id}`).set({ Authorization: `Bearer ${v.body.access_token}` }).expect(404);
  });

  // ── Assets ───────────────────────────────────────────────

  it('adds a caption asset without a file', async () => {
    const id = await createDraft();
    const res = await http()
      .post(`/campaigns/${id}/assets`)
      .set(auth())
      .field('kind', 'CAPTION')
      .field('caption_text', 'Shop the collection — link in bio.')
      .expect(201);
    expect(res.body.kind).toBe('CAPTION');
    expect(res.body.caption_text).toContain('Shop the collection');
    expect(res.body.file).toBeNull();
  });

  it('stores an uploaded image and reports its size', async () => {
    const id = await createDraft();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const res = await http()
      .post(`/campaigns/${id}/assets`)
      .set(auth())
      .field('kind', 'IMAGE')
      .attach('file', png, { filename: 'a.png', contentType: 'image/png' })
      .expect(201);

    expect(res.body.file.mime_type).toBe('image/png');
    expect(res.body.file.size_bytes).toBe(png.byteLength);

    const list = await http().get(`/campaigns/${id}/assets`).set(auth()).expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('rejects an unsupported file type', async () => {
    const id = await createDraft();
    await http()
      .post(`/campaigns/${id}/assets`)
      .set(auth())
      .field('kind', 'IMAGE')
      .attach('file', Buffer.from('#!/bin/sh\n'), { filename: 'x.sh', contentType: 'application/x-sh' })
      .expect(400);
  });

  it('rejects an image asset with no file', async () => {
    const id = await createDraft();
    await http().post(`/campaigns/${id}/assets`).set(auth()).field('kind', 'IMAGE').expect(400);
  });
});
