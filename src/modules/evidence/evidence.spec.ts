import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  AssignmentStatus,
  CampaignObjective,
  CampaignStatus,
  Platform,
  PrismaClient,
  PromoterRole,
  Role,
  SlotStatus,
  Verdict,
  VerificationTier,
} from '@prisma/client';
import request from 'supertest';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RolesGuard } from '../../common/auth/roles.guard';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageModule } from '../../common/storage/storage.module';
import { EvidenceModule } from './evidence.module';
import { testPrisma } from '../../../test/test-db';

/**
 * B7 done-when: the same image on a second submission flags it and links the
 * original — and nothing auto-approves.
 */
describe('evidence — submission and duplicate detection', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let jwt: JwtService;
  let seq = 0;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test_access_secret';
    prisma = testPrisma();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({}), PrismaModule, StorageModule, EvidenceModule],
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
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE users, user_roles, promoter_profiles, channels, client_orgs, campaigns, campaign_slots, offers, assignments, submissions, proof_artifacts, files, tracking_links RESTART IDENTITY CASCADE',
    );
  });

  const http = () => request(app.getHttpServer());
  const token = (id: string) => jwt.sign({ sub: id, roles: [Role.PROMOTER] }, { secret: process.env.JWT_ACCESS_SECRET });

  async function makeImage(seed: number, w = 300, h = 300): Promise<Buffer> {
    const ch = 3;
    const raw = Buffer.alloc(w * h * ch);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * ch;
        const block = Math.floor(x / 40) + Math.floor(y / 40) * seed;
        raw[i] = (x * 2 + seed * 40) % 256;
        raw[i + 1] = (y * 2 + block * 30) % 256;
        raw[i + 2] = (block * 60 + seed * 17) % 256;
      }
    }
    return sharp(raw, { raw: { width: w, height: h, channels: ch } }).png().toBuffer();
  }

  /** A promoter holding an IN_PROGRESS assignment, ready to submit proof. */
  async function makeAssignment(): Promise<{ assignmentId: string; promoterId: string }> {
    const n = seq++;
    const owner = await prisma.user.create({ data: { email: `c${n}@x.com`, phoneE164: `+23481${String(n).padStart(8, '0')}`, passwordHash: 'x' } });
    const org = await prisma.clientOrg.create({ data: { ownerUserId: owner.id, name: `Org${n}` } });
    const campaign = await prisma.campaign.create({
      data: { clientOrgId: org.id, name: `C${n}`, objective: CampaignObjective.AWARENESS, destinationUrl: 'https://x.example/go', status: CampaignStatus.LIVE, budgetMinor: 0n, slotsTotal: 1 },
    });
    const promoter = await prisma.user.create({
      data: { email: `p${n}@x.com`, phoneE164: `+23482${String(n).padStart(8, '0')}`, passwordHash: 'x', status: 'ACTIVE', roles: { create: { role: Role.PROMOTER } } },
    });
    const channel = await prisma.channel.create({
      data: { promoterId: promoter.id, platform: Platform.INSTAGRAM, claimedAudience: 1000, verificationTier: VerificationTier.SELF, effectiveReach: 60 },
    });
    const slot = await prisma.campaignSlot.create({ data: { campaignId: campaign.id, role: PromoterRole.DISTRIBUTOR, unitPriceMinor: 3000n, status: SlotStatus.FILLED } });
    const offer = await prisma.offer.create({
      data: { campaignId: campaign.id, promoterId: promoter.id, channelId: channel.id, role: PromoterRole.DISTRIBUTOR, feeMinor: 2100n, expiresAt: new Date(Date.now() + 1e6), status: 'ACCEPTED' },
    });
    const assignment = await prisma.assignment.create({
      data: { offerId: offer.id, campaignId: campaign.id, promoterId: promoter.id, channelId: channel.id, slotId: slot.id, role: PromoterRole.DISTRIBUTOR, feeMinor: 2100n, trackingToken: randomBytes(12).toString('base64url'), status: AssignmentStatus.IN_PROGRESS },
    });
    return { assignmentId: assignment.id, promoterId: promoter.id };
  }

  // ── The done-when ────────────────────────────────────────

  it('flags a duplicate screenshot on a second submission and links the original', async () => {
    const image = await makeImage(1);

    const first = await makeAssignment();
    const firstRes = await http()
      .post(`/assignments/${first.assignmentId}/submission`)
      .set({ Authorization: `Bearer ${token(first.promoterId)}` })
      .attach('file', image, { filename: 'proof.png', contentType: 'image/png' })
      .expect(201);
    expect(firstRes.body.auto_flag).toBe(false);

    // A different promoter submits the same screenshot.
    const second = await makeAssignment();
    const secondRes = await http()
      .post(`/assignments/${second.assignmentId}/submission`)
      .set({ Authorization: `Bearer ${token(second.promoterId)}` })
      .attach('file', image, { filename: 'proof.png', contentType: 'image/png' })
      .expect(201);

    expect(secondRes.body.auto_flag).toBe(true);

    // …and the artifact points at the original it duplicates.
    const artifacts = await prisma.proofArtifact.findMany({ orderBy: { createdAt: 'asc' } });
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]!.reuseOfId).toBeNull();
    expect(artifacts[1]!.reuseOfId).toBe(artifacts[0]!.id);
  });

  it('flags a re-compressed and resized version of the same screenshot', async () => {
    const original = await makeImage(1);
    // The realistic recycling case: re-saved and shrunk on the way through.
    const mangled = await sharp(original).resize(200, 200).jpeg({ quality: 70 }).toBuffer();

    const a = await makeAssignment();
    await http().post(`/assignments/${a.assignmentId}/submission`).set({ Authorization: `Bearer ${token(a.promoterId)}` })
      .attach('file', original, { filename: 'a.png', contentType: 'image/png' }).expect(201);

    const b = await makeAssignment();
    const res = await http().post(`/assignments/${b.assignmentId}/submission`).set({ Authorization: `Bearer ${token(b.promoterId)}` })
      .attach('file', mangled, { filename: 'b.jpg', contentType: 'image/jpeg' }).expect(201);

    expect(res.body.auto_flag).toBe(true);
  });

  it('does not flag genuinely different screenshots', async () => {
    const a = await makeAssignment();
    await http().post(`/assignments/${a.assignmentId}/submission`).set({ Authorization: `Bearer ${token(a.promoterId)}` })
      .attach('file', await makeImage(1), { filename: 'a.png', contentType: 'image/png' }).expect(201);

    const b = await makeAssignment();
    const res = await http().post(`/assignments/${b.assignmentId}/submission`).set({ Authorization: `Bearer ${token(b.promoterId)}` })
      .attach('file', await makeImage(4), { filename: 'b.png', contentType: 'image/png' }).expect(201);

    expect(res.body.auto_flag).toBe(false);
    const artifacts = await prisma.proofArtifact.findMany({ orderBy: { createdAt: 'asc' } });
    expect(artifacts[1]!.reuseOfId).toBeNull();
  });

  it('a chain of reuses all point at the original, not at each other', async () => {
    const image = await makeImage(2);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await makeAssignment();
      await http().post(`/assignments/${a.assignmentId}/submission`).set({ Authorization: `Bearer ${token(a.promoterId)}` })
        .attach('file', image, { filename: 'p.png', contentType: 'image/png' }).expect(201);
      ids.push(a.assignmentId);
    }

    const artifacts = await prisma.proofArtifact.findMany({ orderBy: { createdAt: 'asc' } });
    expect(artifacts).toHaveLength(3);
    expect(artifacts[0]!.reuseOfId).toBeNull();
    // Both later copies reference the first, so an admin sees one origin.
    expect(artifacts[1]!.reuseOfId).toBe(artifacts[0]!.id);
    expect(artifacts[2]!.reuseOfId).toBe(artifacts[0]!.id);
  });

  // ── No auto-approval (§5.5) ──────────────────────────────

  it('every submission lands PENDING — nothing auto-approves, flagged or not', async () => {
    const clean = await makeAssignment();
    const cleanRes = await http().post(`/assignments/${clean.assignmentId}/submission`).set({ Authorization: `Bearer ${token(clean.promoterId)}` })
      .attach('file', await makeImage(5), { filename: 'a.png', contentType: 'image/png' }).expect(201);
    expect(cleanRes.body.verdict).toBe(Verdict.PENDING);

    const dup = await makeAssignment();
    const dupRes = await http().post(`/assignments/${dup.assignmentId}/submission`).set({ Authorization: `Bearer ${token(dup.promoterId)}` })
      .attach('file', await makeImage(5), { filename: 'b.png', contentType: 'image/png' }).expect(201);
    // Flagged, but still PENDING — the flag informs a human, it does not reject.
    expect(dupRes.body.auto_flag).toBe(true);
    expect(dupRes.body.verdict).toBe(Verdict.PENDING);

    expect(await prisma.submission.count({ where: { verdict: Verdict.PENDING } })).toBe(2);
    expect(await prisma.submission.count({ where: { verdict: { not: Verdict.PENDING } } })).toBe(0);
  });

  it('moves the assignment to SUBMITTED', async () => {
    const a = await makeAssignment();
    await http().post(`/assignments/${a.assignmentId}/submission`).set({ Authorization: `Bearer ${token(a.promoterId)}` })
      .attach('file', await makeImage(6), { filename: 'a.png', contentType: 'image/png' }).expect(201);

    const assignment = await prisma.assignment.findUnique({ where: { id: a.assignmentId } });
    expect(assignment!.status).toBe(AssignmentStatus.SUBMITTED);
  });

  // ── Inputs ───────────────────────────────────────────────

  it('requires a screenshot', async () => {
    const a = await makeAssignment();
    await http().post(`/assignments/${a.assignmentId}/submission`).set({ Authorization: `Bearer ${token(a.promoterId)}` })
      .field('note', 'no file attached').expect(400);
  });

  it('accepts a submission without a public URL (WhatsApp status has none)', async () => {
    const a = await makeAssignment();
    const res = await http().post(`/assignments/${a.assignmentId}/submission`).set({ Authorization: `Bearer ${token(a.promoterId)}` })
      .attach('file', await makeImage(7), { filename: 'a.png', contentType: 'image/png' })
      .field('note', 'Posted to my status').expect(201);
    expect(res.body.public_url).toBeNull();
    expect(res.body.note).toBe('Posted to my status');
  });

  it('stores a public URL when given', async () => {
    const a = await makeAssignment();
    const res = await http().post(`/assignments/${a.assignmentId}/submission`).set({ Authorization: `Bearer ${token(a.promoterId)}` })
      .attach('file', await makeImage(8), { filename: 'a.png', contentType: 'image/png' })
      .field('public_url', 'https://instagram.com/p/abc123').expect(201);
    expect(res.body.public_url).toBe('https://instagram.com/p/abc123');
  });

  it('rejects a non-image and a file that is not decodable', async () => {
    const a = await makeAssignment();
    await http().post(`/assignments/${a.assignmentId}/submission`).set({ Authorization: `Bearer ${token(a.promoterId)}` })
      .attach('file', Buffer.from('#!/bin/sh\necho hi'), { filename: 'x.sh', contentType: 'application/x-sh' }).expect(400);

    // Correct MIME, but the bytes are not an image.
    await http().post(`/assignments/${a.assignmentId}/submission`).set({ Authorization: `Bearer ${token(a.promoterId)}` })
      .attach('file', Buffer.from('not an image at all'), { filename: 'x.png', contentType: 'image/png' }).expect(400);

    // Nothing was stored for either attempt.
    expect(await prisma.submission.count()).toBe(0);
    expect(await prisma.file.count()).toBe(0);
  });

  // ── Ownership ────────────────────────────────────────────

  it('cannot submit against someone else’s assignment', async () => {
    const a = await makeAssignment();
    const other = await makeAssignment();
    await http().post(`/assignments/${a.assignmentId}/submission`).set({ Authorization: `Bearer ${token(other.promoterId)}` })
      .attach('file', await makeImage(9), { filename: 'a.png', contentType: 'image/png' }).expect(404);
  });

  it('cannot submit twice while already awaiting review', async () => {
    const a = await makeAssignment();
    await http().post(`/assignments/${a.assignmentId}/submission`).set({ Authorization: `Bearer ${token(a.promoterId)}` })
      .attach('file', await makeImage(10), { filename: 'a.png', contentType: 'image/png' }).expect(201);
    // Now SUBMITTED — not awaiting proof.
    await http().post(`/assignments/${a.assignmentId}/submission`).set({ Authorization: `Bearer ${token(a.promoterId)}` })
      .attach('file', await makeImage(11), { filename: 'b.png', contentType: 'image/png' }).expect(400);
  });

  it('allows resubmission after a rejection', async () => {
    const a = await makeAssignment();
    await http().post(`/assignments/${a.assignmentId}/submission`).set({ Authorization: `Bearer ${token(a.promoterId)}` })
      .attach('file', await makeImage(12), { filename: 'a.png', contentType: 'image/png' }).expect(201);
    await prisma.assignment.update({ where: { id: a.assignmentId }, data: { status: AssignmentStatus.REJECTED } });

    await http().post(`/assignments/${a.assignmentId}/submission`).set({ Authorization: `Bearer ${token(a.promoterId)}` })
      .attach('file', await makeImage(13), { filename: 'b.png', contentType: 'image/png' }).expect(201);
    expect(await prisma.submission.count({ where: { assignmentId: a.assignmentId } })).toBe(2);
  });

  it('requires authentication', async () => {
    const a = await makeAssignment();
    await http().post(`/assignments/${a.assignmentId}/submission`)
      .attach('file', await makeImage(14), { filename: 'a.png', contentType: 'image/png' }).expect(401);
  });
});
