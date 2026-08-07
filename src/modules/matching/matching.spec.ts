import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  AssignmentStatus,
  CampaignObjective,
  CampaignStatus,
  ChannelStatus,
  OfferStatus,
  Platform,
  PromoterRole,
  PromoterStatus,
  PrismaClient,
  Role,
  SlotStatus,
  VerificationTier,
} from '@prisma/client';
import request from 'supertest';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RolesGuard } from '../../common/auth/roles.guard';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateConfigModule } from '../../common/rate-config/rate-config.module';
import { computeEffectiveReach } from '../../common/reach/effective-reach';
import { MatchingModule } from './matching.module';
import { MatchingService } from './matching.service';
import { testPrisma } from '../../../test/test-db';

describe('matching — candidates, offers, accept', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let matching: MatchingService;
  let jwt: JwtService;
  let seq = 0;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test_access_secret';
    prisma = testPrisma();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        JwtModule.register({}),
        PrismaModule,
        RateConfigModule,
        MatchingModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    matching = app.get(MatchingService);
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE users, user_roles, promoter_profiles, channels, client_orgs, campaigns, campaign_targeting, campaign_slots, offers, assignments, tracking_links, rate_config RESTART IDENTITY CASCADE',
    );
    await prisma.rateConfig.create({ data: { isActive: true } });
  });

  const http = () => request(app.getHttpServer());
  const token = (userId: string, roles: Role[]) =>
    jwt.sign({ sub: userId, roles }, { secret: process.env.JWT_ACCESS_SECRET });

  // ── Fixtures ─────────────────────────────────────────────

  async function makeAdmin(): Promise<string> {
    const admin = await prisma.user.create({
      data: {
        email: `admin${seq++}@ralia.test`, phoneE164: `+2348000${String(seq).padStart(6, '0')}`,
        passwordHash: 'x', status: 'ACTIVE',
        roles: { create: { role: Role.ADMIN, capabilities: ['REVIEW_EVIDENCE', 'RECORD_MONEY'] } },
      },
    });
    return admin.id;
  }

  async function makeLiveCampaign(slots: number, opts: { minReach?: number; platform?: Platform; state?: string } = {}): Promise<string> {
    const owner = await prisma.user.create({
      data: { email: `c${seq++}@x.com`, phoneE164: `+23481${String(seq).padStart(8, '0')}`, passwordHash: 'x', status: 'ACTIVE', roles: { create: { role: Role.CLIENT } } },
    });
    const org = await prisma.clientOrg.create({ data: { ownerUserId: owner.id, name: `Org${seq}`, status: 'ACTIVE' } });
    const campaign = await prisma.campaign.create({
      data: {
        clientOrgId: org.id, name: `Camp${seq}`, objective: CampaignObjective.AWARENESS,
        destinationUrl: 'https://x.example/go', status: CampaignStatus.LIVE,
        budgetMinor: 34500n, priceMinor: 34500n, slotsTotal: slots, quotedAt: new Date(),
        targeting: {
          create: {
            states: opts.state ? [opts.state] : [], lgas: [], genders: [], languages: [],
            categories: [], platforms: opts.platform ? [opts.platform] : [],
            minEffectiveReach: opts.minReach ?? 0, roles: [],
          },
        },
        slots: { create: Array.from({ length: slots }, () => ({ role: PromoterRole.DISTRIBUTOR, unitPriceMinor: 3450n, status: SlotStatus.OPEN })) },
      },
    });
    return campaign.id;
  }

  async function makePromoter(opts: { state?: string; platform?: Platform; claimed?: number; trust?: number; age?: number } = {}): Promise<{ userId: string; channelId: string }> {
    const platform = opts.platform ?? Platform.INSTAGRAM;
    const claimed = opts.claimed ?? 20_000;
    const user = await prisma.user.create({
      data: { email: `p${seq++}@x.com`, phoneE164: `+23482${String(seq).padStart(8, '0')}`, passwordHash: 'x', status: 'ACTIVE', phoneVerifiedAt: new Date(), roles: { create: { role: Role.PROMOTER } } },
    });
    await prisma.promoterProfile.create({
      data: {
        userId: user.id, status: PromoterStatus.ACTIVE, age: opts.age ?? 25,
        locationState: opts.state ?? 'Lagos', languagesSpoken: ['English'], preferredCategories: ['Fashion'],
        trustScore: opts.trust ?? 60, maxCampaignsPerWeek: 3,
      },
    });
    const channel = await prisma.channel.create({
      data: {
        promoterId: user.id, platform, claimedAudience: claimed, verificationTier: VerificationTier.SCREENSHOT,
        effectiveReach: computeEffectiveReach(claimed, platform, VerificationTier.SCREENSHOT), status: ChannelStatus.ACTIVE,
      },
    });
    return { userId: user.id, channelId: channel.id };
  }

  async function sendOffer(campaignId: string, promoterId: string): Promise<string> {
    const [offer] = await matching.sendOffers(campaignId, [promoterId]);
    return offer!.id;
  }

  // ── The headline: concurrency ────────────────────────────

  it('N simultaneous accepts on an M-slot campaign fill exactly M', async () => {
    const M = 5;
    const N = 25;
    const campaignId = await makeLiveCampaign(M);

    const offerIds: { offerId: string; promoterId: string }[] = [];
    for (let i = 0; i < N; i++) {
      const p = await makePromoter();
      offerIds.push({ offerId: await sendOffer(campaignId, p.userId), promoterId: p.userId });
    }

    // Fire all N accepts at once. The slot reservation must let exactly M win.
    const results = await Promise.allSettled(
      offerIds.map(({ offerId, promoterId }) => matching.accept(offerId, promoterId)),
    );

    const accepted = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(accepted).toHaveLength(M);
    expect(rejected).toHaveLength(N - M);

    // The ledger of record agrees: M filled slots, M assignments, no oversell.
    expect(await prisma.campaignSlot.count({ where: { campaignId, status: SlotStatus.FILLED } })).toBe(M);
    expect(await prisma.campaignSlot.count({ where: { campaignId, status: SlotStatus.OPEN } })).toBe(0);
    expect(await prisma.assignment.count({ where: { campaignId } })).toBe(M);
    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    expect(campaign!.slotsFilled).toBe(M);

    // Every filled slot maps to exactly one assignment — no two assignments share a slot.
    const assignments = await prisma.assignment.findMany({ where: { campaignId } });
    const slotIds = assignments.map((a) => a.slotId);
    expect(new Set(slotIds).size).toBe(M);
    expect(slotIds.every((s) => s !== null)).toBe(true);
  });

  it('the same offer accepted twice concurrently yields one assignment', async () => {
    const campaignId = await makeLiveCampaign(5);
    const p = await makePromoter();
    const offerId = await sendOffer(campaignId, p.userId);

    const results = await Promise.allSettled([
      matching.accept(offerId, p.userId),
      matching.accept(offerId, p.userId),
      matching.accept(offerId, p.userId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.assignment.count({ where: { offerId } })).toBe(1);
    // Only one slot consumed despite three attempts.
    expect(await prisma.campaignSlot.count({ where: { campaignId, status: SlotStatus.FILLED } })).toBe(1);
  });

  // ── Accept / decline behaviour ───────────────────────────

  it('accept issues an assignment with a tracking token and link', async () => {
    const campaignId = await makeLiveCampaign(2);
    const p = await makePromoter();
    const offerId = await sendOffer(campaignId, p.userId);

    const a = await matching.accept(offerId, p.userId);
    expect(a.status).toBe(AssignmentStatus.IN_PROGRESS);
    expect(a.tracking_token).toBeTruthy();

    const link = await prisma.trackingLink.findUnique({ where: { token: a.tracking_token } });
    expect(link).not.toBeNull();
    expect(link!.destinationUrl).toBe('https://x.example/go');

    const offer = await prisma.offer.findUnique({ where: { id: offerId } });
    expect(offer!.status).toBe(OfferStatus.ACCEPTED);
  });

  it('declining an offer leaves slots untouched', async () => {
    const campaignId = await makeLiveCampaign(2);
    const p = await makePromoter();
    const offerId = await sendOffer(campaignId, p.userId);

    await matching.decline(offerId, p.userId);
    const offer = await prisma.offer.findUnique({ where: { id: offerId } });
    expect(offer!.status).toBe(OfferStatus.DECLINED);
    expect(await prisma.campaignSlot.count({ where: { campaignId, status: SlotStatus.OPEN } })).toBe(2);

    // A declined offer cannot then be accepted.
    await expect(matching.accept(offerId, p.userId)).rejects.toThrow(/declined/i);
  });

  it('an expired offer cannot be accepted', async () => {
    const campaignId = await makeLiveCampaign(2);
    const p = await makePromoter();
    const offerId = await sendOffer(campaignId, p.userId);
    await prisma.offer.update({ where: { id: offerId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(matching.accept(offerId, p.userId)).rejects.toThrow(/expired/i);
  });

  it('a promoter cannot accept someone else’s offer', async () => {
    const campaignId = await makeLiveCampaign(2);
    const p = await makePromoter();
    const other = await makePromoter();
    const offerId = await sendOffer(campaignId, p.userId);

    await expect(matching.accept(offerId, other.userId)).rejects.toThrow(/No such offer/);
  });

  // ── §5.3 hard filter ─────────────────────────────────────

  it('filters candidates by every hard clause', async () => {
    const campaignId = await makeLiveCampaign(10, { minReach: 1000, platform: Platform.INSTAGRAM, state: 'Lagos' });

    const good = await makePromoter({ state: 'Lagos', platform: Platform.INSTAGRAM, claimed: 20_000, trust: 60, age: 25 });
    await makePromoter({ state: 'Kano', platform: Platform.INSTAGRAM });                 // wrong state
    await makePromoter({ state: 'Lagos', platform: Platform.X });                        // wrong platform
    await makePromoter({ state: 'Lagos', platform: Platform.INSTAGRAM, claimed: 100 });  // reach too low
    await makePromoter({ state: 'Lagos', platform: Platform.INSTAGRAM, trust: 10 });     // trust too low

    const candidates = await matching.candidates(campaignId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.promoter_id).toBe(good.userId);
  });

  it('excludes promoters already offered or assigned on the campaign', async () => {
    const campaignId = await makeLiveCampaign(10, { minReach: 500 });
    const a = await makePromoter();
    const b = await makePromoter();

    expect(await matching.candidates(campaignId)).toHaveLength(2);

    await sendOffer(campaignId, a.userId);
    const after = await matching.candidates(campaignId);
    expect(after.map((c) => c.promoter_id)).toEqual([b.userId]);
  });

  it('uses the admin-confirmed capability when present, not the provisional estimate', async () => {
    const campaignId = await makeLiveCampaign(10, { minReach: 100, platform: Platform.INSTAGRAM });
    const p = await makePromoter({ platform: Platform.INSTAGRAM, claimed: 20_000 });
    await prisma.promoterProfile.update({
      where: { userId: p.userId },
      data: { roles: { set: ['DISTRIBUTOR'] }, capabilityScores: { DISTRIBUTOR: 95 } },
    });

    const [candidate] = await matching.candidates(campaignId);
    expect(candidate!.capability).toBe(95); // the stored score, verbatim
  });

  it('surfaces human clicks (bots excluded) on my assignments', async () => {
    const campaignId = await makeLiveCampaign(1, { minReach: 500 });
    const p = await makePromoter();
    const offerId = await sendOffer(campaignId, p.userId);
    const a = await matching.accept(offerId, p.userId);
    const link = await prisma.trackingLink.findUniqueOrThrow({ where: { assignmentId: a.id } });
    await prisma.clickEvent.createMany({
      data: [
        { token: link.token, ipHash: 'h1', uaHash: 'u1', isBot: false },
        { token: link.token, ipHash: 'h2', uaHash: 'u2', isBot: false },
        { token: link.token, ipHash: 'h3', uaHash: 'u3', isBot: true }, // excluded
      ],
    });

    const mine = await matching.myAssignments(p.userId);
    expect(mine[0]!.clicks).toBe(2);
  });

  it('notifies the promoter when an offer is created', async () => {
    const campaignId = await makeLiveCampaign(10, { minReach: 500 });
    const p = await makePromoter();

    await sendOffer(campaignId, p.userId);

    const note = await prisma.notification.findFirstOrThrow({ where: { userId: p.userId } });
    expect(note.type).toBe('offer.created');
    expect(note.emailStatus).toBe('PENDING');
    expect(note.body).toMatch(/offer/i);
  });

  it('a declined promoter stays out of the pool (one offer per campaign, lifetime)', async () => {
    const campaignId = await makeLiveCampaign(10, { minReach: 500 });
    const p = await makePromoter();

    const offerId = await sendOffer(campaignId, p.userId);
    await matching.decline(offerId, p.userId);

    // Despite being neither SENT nor ACCEPTED, they can't be re-offered (unique
    // constraint), so candidates() must not surface them again.
    const after = await matching.candidates(campaignId);
    expect(after.map((c) => c.promoter_id)).not.toContain(p.userId);
  });

  it('excludes a promoter at their weekly cap', async () => {
    const p = await makePromoter();
    await prisma.promoterProfile.update({ where: { userId: p.userId }, data: { maxCampaignsPerWeek: 1 } });

    // Spend the promoter's one weekly slot on a real assignment via the offer chain.
    const otherCampaign = await makeLiveCampaign(2, { minReach: 500 });
    const otherOffer = await sendOffer(otherCampaign, p.userId);
    await matching.accept(otherOffer, p.userId);
    expect(await prisma.assignment.count({ where: { promoterId: p.userId } })).toBe(1);

    // Now they are at cap for a fresh campaign.
    const campaignId = await makeLiveCampaign(10, { minReach: 500 });
    const candidates = await matching.candidates(campaignId);
    expect(candidates.map((c) => c.promoter_id)).not.toContain(p.userId);
  });

  it('ranks candidates by match score with the transparency fields (v2)', async () => {
    const campaignId = await makeLiveCampaign(10, { minReach: 100, platform: Platform.INSTAGRAM });
    await makePromoter({ platform: Platform.INSTAGRAM, claimed: 5_000 });
    await makePromoter({ platform: Platform.INSTAGRAM, claimed: 50_000 });
    await makePromoter({ platform: Platform.INSTAGRAM, claimed: 20_000 });

    const candidates = await matching.candidates(campaignId);
    expect(candidates.length).toBe(3);

    // Ordered by the performance-weighted score, not raw reach.
    const scores = candidates.map((c) => c.match_score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    // Every candidate carries the §7 transparency surface.
    for (const c of candidates) {
      expect(c.fit_pct).toBe(Math.round(c.match_score * 100));
      expect(c.fit_pct).toBeGreaterThanOrEqual(0);
      expect(c.fit_pct).toBeLessThanOrEqual(100);
      expect(c.capability).toBeGreaterThanOrEqual(0);
      expect(c.capability).toBeLessThanOrEqual(100);
      expect(typeof c.capability_tier).toBe('string');
      expect(c.reliability).toBeGreaterThanOrEqual(0);
    }
  });

  // ── Send-offer rules ─────────────────────────────────────

  it('refuses to send offers on a non-LIVE campaign', async () => {
    const campaignId = await makeLiveCampaign(5);
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: CampaignStatus.PENDING_APPROVAL } });
    const p = await makePromoter();
    await expect(matching.sendOffers(campaignId, [p.userId])).rejects.toThrow(/LIVE/);
  });

  it('does not double-offer the same promoter', async () => {
    const campaignId = await makeLiveCampaign(5);
    const p = await makePromoter();
    await matching.sendOffers(campaignId, [p.userId]);
    const second = await matching.sendOffers(campaignId, [p.userId]);
    expect(second).toHaveLength(0); // skipped, not duplicated
    expect(await prisma.offer.count({ where: { campaignId, promoterId: p.userId } })).toBe(1);
  });

  it('the offer fee is the promoter’s 50% share of the slot price', async () => {
    const campaignId = await makeLiveCampaign(5);
    const p = await makePromoter();
    const [offer] = await matching.sendOffers(campaignId, [p.userId]);
    // Per-promoter pricing: reach 2000 (20k Instagram × 0.10 × screenshot 1.0),
    // AWARENESS, no filters → gross (2000/1000)×3000 = 6000 → fee round(6000×0.5) = 3000.
    expect(offer!.fee_minor).toBe(3000);
    // The gross and promised reach are frozen on the row for settlement.
    const row = await prisma.offer.findUniqueOrThrow({ where: { id: offer!.id } });
    expect(row.grossMinor).toBe(6000n);
    expect(row.promisedReach).toBe(2000);
  });

  // ── Access control (HTTP) ────────────────────────────────

  it('only an admin sees candidates; only a promoter accepts', async () => {
    const campaignId = await makeLiveCampaign(3, { minReach: 500 });
    const p = await makePromoter();
    const offerId = await sendOffer(campaignId, p.userId);
    const adminId = await makeAdmin();

    // Promoter hitting the admin candidates endpoint → 403.
    await http().get(`/campaigns/${campaignId}/candidates`).set({ Authorization: `Bearer ${token(p.userId, [Role.PROMOTER])}` }).expect(403);
    // Admin → 200.
    await http().get(`/campaigns/${campaignId}/candidates`).set({ Authorization: `Bearer ${token(adminId, [Role.ADMIN])}` }).expect(200);

    // Admin hitting the promoter accept endpoint → 403.
    await http().post(`/offers/${offerId}/accept`).set({ Authorization: `Bearer ${token(adminId, [Role.ADMIN])}` }).expect(403);
    // Promoter accept → 200.
    await http().post(`/offers/${offerId}/accept`).set({ Authorization: `Bearer ${token(p.userId, [Role.PROMOTER])}` }).expect(200);
  });
});
