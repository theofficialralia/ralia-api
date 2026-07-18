import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  AssignmentStatus,
  CampaignObjective,
  CampaignStatus,
  Platform,
  PromoterRole,
  PrismaClient,
  Role,
  SlotStatus,
  VerificationTier,
} from '@prisma/client';
import request from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RolesGuard } from '../../common/auth/roles.guard';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TrackingModule } from './tracking.module';
import { TrackingService } from './tracking.service';
import { testPrisma } from '../../../test/test-db';

/**
 * B6 done-when: a tracking link records a click and redirects to the destination.
 */
describe('tracking — redirect and click ingestion', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let seq = 0;

  const DESTINATION = 'https://naijathreads.example/shop?ref=abc';

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test_access_secret';
    process.env.TRACKING_HASH_SALT ??= 'test_salt';
    prisma = testPrisma();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({}), PrismaModule, TrackingModule],
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
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE users, promoter_profiles, channels, client_orgs, campaigns, campaign_slots, offers, assignments, tracking_links, click_events RESTART IDENTITY CASCADE',
    );
  });

  const http = () => request(app.getHttpServer());

  /** A full assignment + tracking link, the shape B5's accept produces. */
  async function makeTrackingLink(destination = DESTINATION): Promise<string> {
    const owner = await prisma.user.create({ data: { email: `c${seq++}@x.com`, phoneE164: `+23481${String(seq).padStart(8, '0')}`, passwordHash: 'x' } });
    const org = await prisma.clientOrg.create({ data: { ownerUserId: owner.id, name: `Org${seq}` } });
    const campaign = await prisma.campaign.create({
      data: { clientOrgId: org.id, name: `C${seq}`, objective: CampaignObjective.AWARENESS, destinationUrl: destination, status: CampaignStatus.LIVE, budgetMinor: 0n, slotsTotal: 1 },
    });
    const promoter = await prisma.user.create({ data: { email: `p${seq++}@x.com`, phoneE164: `+23482${String(seq).padStart(8, '0')}`, passwordHash: 'x' } });
    const channel = await prisma.channel.create({ data: { promoterId: promoter.id, platform: Platform.INSTAGRAM, claimedAudience: 1000, verificationTier: VerificationTier.SELF, effectiveReach: 60 } });
    const slot = await prisma.campaignSlot.create({ data: { campaignId: campaign.id, role: PromoterRole.DISTRIBUTOR, unitPriceMinor: 3000n, status: SlotStatus.FILLED } });
    const offer = await prisma.offer.create({ data: { campaignId: campaign.id, promoterId: promoter.id, channelId: channel.id, role: PromoterRole.DISTRIBUTOR, feeMinor: 2100n, expiresAt: new Date(Date.now() + 1e6) } });
    const assignment = await prisma.assignment.create({
      data: { offerId: offer.id, campaignId: campaign.id, promoterId: promoter.id, channelId: channel.id, slotId: slot.id, role: PromoterRole.DISTRIBUTOR, feeMinor: 2100n, trackingToken: randomBytes(18).toString('base64url'), status: AssignmentStatus.IN_PROGRESS },
    });
    await prisma.trackingLink.create({ data: { token: assignment.trackingToken, assignmentId: assignment.id, destinationUrl: destination } });
    return assignment.trackingToken;
  }

  // ── The done-when ────────────────────────────────────────

  it('redirects to the destination and records the click', async () => {
    const token = await makeTrackingLink();

    const res = await http().get(`/r/${token}`).redirects(0).expect(302);
    expect(res.headers.location).toBe(DESTINATION);

    const clicks = await prisma.clickEvent.findMany({ where: { token } });
    expect(clicks).toHaveLength(1);
  });

  it('is public — no auth needed', async () => {
    const token = await makeTrackingLink();
    // No Authorization header; the global JwtAuthGuard must not block it.
    await http().get(`/r/${token}`).redirects(0).expect(302);
  });

  it('is served unversioned, not under /v1', async () => {
    const token = await makeTrackingLink();
    await http().get(`/v1/r/${token}`).redirects(0).expect(404);
    await http().get(`/r/${token}`).redirects(0).expect(302);
  });

  it('records a fresh click per hit', async () => {
    const token = await makeTrackingLink();
    await http().get(`/r/${token}`).redirects(0).expect(302);
    await http().get(`/r/${token}`).redirects(0).expect(302);
    await http().get(`/r/${token}`).redirects(0).expect(302);
    expect(await prisma.clickEvent.count({ where: { token } })).toBe(3);
  });

  it('404s an unknown token without redirecting', async () => {
    const res = await http().get('/r/does-not-exist').redirects(0);
    expect(res.status).toBe(404);
    expect(res.headers.location).toBeUndefined();
  });

  // ── Privacy (§7) ─────────────────────────────────────────

  it('never stores a raw IP or user-agent — only hashes', async () => {
    const token = await makeTrackingLink();
    await http()
      .get(`/r/${token}`)
      .set('X-Forwarded-For', '203.0.113.7')
      .set('User-Agent', 'Mozilla/5.0 (iPhone)')
      .redirects(0)
      .expect(302);

    const click = await prisma.clickEvent.findFirst({ where: { token } });
    expect(click).not.toBeNull();
    // The raw IP and UA appear nowhere.
    expect(click!.ipHash).not.toContain('203.0.113.7');
    expect(click!.uaHash).not.toContain('iPhone');
    expect(click!.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(click!.uaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the same IP stably and different IPs distinctly', async () => {
    const token = await makeTrackingLink();
    await http().get(`/r/${token}`).set('X-Forwarded-For', '198.51.100.1').redirects(0).expect(302);
    await http().get(`/r/${token}`).set('X-Forwarded-For', '198.51.100.1').redirects(0).expect(302);
    await http().get(`/r/${token}`).set('X-Forwarded-For', '198.51.100.2').redirects(0).expect(302);

    const clicks = await prisma.clickEvent.findMany({ where: { token }, orderBy: { ts: 'asc' } });
    expect(clicks[0]!.ipHash).toBe(clicks[1]!.ipHash); // same IP → same hash
    expect(clicks[0]!.ipHash).not.toBe(clicks[2]!.ipHash); // different IP → different hash
  });

  // ── Obvious bots (thin heuristic) ────────────────────────

  it('flags an obvious bot UA but still redirects it', async () => {
    const token = await makeTrackingLink();
    await http().get(`/r/${token}`).set('User-Agent', 'Googlebot/2.1').redirects(0).expect(302);

    const click = await prisma.clickEvent.findFirst({ where: { token } });
    expect(click!.isBot).toBe(true);
  });

  it('does not flag a normal browser UA', async () => {
    const token = await makeTrackingLink();
    await http().get(`/r/${token}`).set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120').redirects(0).expect(302);

    const click = await prisma.clickEvent.findFirst({ where: { token } });
    expect(click!.isBot).toBe(false);
  });

});

/**
 * The redirect is the user-facing function; the click is analytics. A failed
 * click write must never deny the redirect. Tested at the service level with a
 * stub, so the failure is deterministic.
 */
describe('tracking — service resilience', () => {
  it('still resolves the destination when the click insert throws', async () => {
    const stubPrisma = {
      trackingLink: {
        findUnique: async () => ({ token: 't', destinationUrl: DESTINATION_URL, assignmentId: 'a' }),
      },
      clickEvent: {
        create: async () => {
          throw new Error('DB down');
        },
      },
    } as unknown as PrismaService;

    const service = new TrackingService(stubPrisma);
    const resolution = await service.resolveAndRecord('t', { ip: '1.2.3.4', userAgent: 'x' });

    expect(resolution).toEqual({ destinationUrl: DESTINATION_URL });
  });

  it('returns null for an unknown token', async () => {
    const stubPrisma = {
      trackingLink: { findUnique: async () => null },
      clickEvent: { create: async () => ({}) },
    } as unknown as PrismaService;

    const service = new TrackingService(stubPrisma);
    expect(await service.resolveAndRecord('nope', { ip: '1.2.3.4', userAgent: 'x' })).toBeNull();
  });
});

const DESTINATION_URL = 'https://naijathreads.example/shop?ref=abc';
