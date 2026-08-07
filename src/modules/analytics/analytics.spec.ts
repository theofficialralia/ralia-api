import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  AccountKind,
  AssignmentStatus,
  CampaignObjective,
  CampaignStatus,
  ChannelStatus,
  EntryDirection,
  LedgerTransactionKind,
  OfferStatus,
  Platform,
  PromoterRole,
  PromoterStatus,
  PrismaClient,
  Role,
  SlotStatus,
  Verdict,
  VerificationTier,
} from '@prisma/client';
import request from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RolesGuard } from '../../common/auth/roles.guard';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageModule } from '../../common/storage/storage.module';
import { AnalyticsModule } from './analytics.module';
import { testPrisma } from '../../../test/test-db';

/**
 * Analytics is read-only, but it reports money and views, so the arithmetic has
 * to be right: spent is what left escrow, views are non-bot clicks, and the
 * derived rates are computed from those, not stored.
 */
describe('analytics — campaign detail and dashboard', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let jwt: JwtService;
  let seq = 0;

  const UNIT = 3450n;
  const FEE = 1725n;
  const TAKE = 1725n;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test_access_secret';
    prisma = testPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({}), PrismaModule, StorageModule, AnalyticsModule],
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
      'TRUNCATE users, user_roles, promoter_profiles, channels, client_orgs, campaigns, campaign_slots, offers, assignments, submissions, proof_artifacts, files, click_events, tracking_links, accounts, ledger_transactions, ledger_entries RESTART IDENTITY CASCADE',
    );
  });

  const http = () => request(app.getHttpServer());
  const bearer = (id: string, roles: Role[]) => ({
    Authorization: `Bearer ${jwt.sign({ sub: id, roles }, { secret: process.env.JWT_ACCESS_SECRET })}`,
  });

  /**
   * A fully-populated campaign: funded escrow, one paid submission, a scatter of
   * offers, and clicks (some bot). Returns the client owner id and campaign id.
   */
  async function seedCampaign(opts: { nonBotClicks: number; botClicks: number }): Promise<{ ownerId: string; campaignId: string; promoterId: string }> {
    const n = seq++;
    const owner = await prisma.user.create({
      data: { email: `c${n}@x.com`, phoneE164: `+23480${String(n).padStart(9, '0')}`, passwordHash: 'x', status: 'ACTIVE', roles: { create: { role: Role.CLIENT } } },
    });
    const org = await prisma.clientOrg.create({ data: { ownerUserId: owner.id, name: `Org${n}` } });
    const escrow = await prisma.account.create({ data: { kind: AccountKind.CAMPAIGN_ESCROW } });
    const promoterAcct = await prisma.account.create({ data: { kind: AccountKind.PROMOTER_AVAILABLE } });
    const revenue = await prisma.account.create({ data: { kind: AccountKind.RALIA_REVENUE } });
    const bank = await prisma.account.create({ data: { kind: AccountKind.BANK_CLEARING } });

    const campaign = await prisma.campaign.create({
      data: {
        clientOrgId: org.id, name: `Lagos launch ${n}`, objective: CampaignObjective.AWARENESS,
        destinationUrl: 'https://x.example/go', status: CampaignStatus.LIVE,
        budgetMinor: UNIT, priceMinor: UNIT, slotsTotal: 1, slotsFilled: 1,
        escrowAccountId: escrow.id, startsAt: new Date('2026-07-02'),
      },
    });
    const slot = await prisma.campaignSlot.create({ data: { campaignId: campaign.id, role: PromoterRole.DISTRIBUTOR, unitPriceMinor: UNIT, status: SlotStatus.FILLED } });

    const promoter = await prisma.user.create({
      data: { email: `p${n}@x.com`, phoneE164: `+23481${String(n).padStart(9, '0')}`, passwordHash: 'x', status: 'ACTIVE', roles: { create: { role: Role.PROMOTER } } },
    });
    await prisma.promoterProfile.create({ data: { userId: promoter.id, status: PromoterStatus.ACTIVE, fullName: 'Adaeze Okafor' } });
    const channel = await prisma.channel.create({
      data: { promoterId: promoter.id, platform: Platform.INSTAGRAM, handle: '@adaeze', claimedAudience: 20000, verificationTier: VerificationTier.SCREENSHOT, effectiveReach: 2000, status: ChannelStatus.ACTIVE },
    });

    const wallet = await prisma.account.create({ data: { kind: AccountKind.CLIENT_WALLET, ownerId: org.id } });

    // Fund the escrow (DR bank / CR escrow). Over-fund by REFUND so there is a
    // realistic later refund debit to prove "spent" excludes it.
    const REFUND = 1000n;
    await postTxn(LedgerTransactionKind.CAMPAIGN_FUNDING, campaign.id, [
      { accountId: bank.id, direction: EntryDirection.DEBIT, amountMinor: UNIT + REFUND },
      { accountId: escrow.id, direction: EntryDirection.CREDIT, amountMinor: UNIT + REFUND },
    ]);

    // Three offers: one accepted, one declined, one still out.
    const token = randomBytes(12).toString('base64url');
    const acceptedOffer = await prisma.offer.create({ data: { campaignId: campaign.id, promoterId: promoter.id, channelId: channel.id, role: PromoterRole.DISTRIBUTOR, feeMinor: FEE, expiresAt: new Date(Date.now() + 1e6), status: OfferStatus.ACCEPTED } });
    const declinedPromoter = await prisma.user.create({ data: { email: `d${n}@x.com`, phoneE164: `+23482${String(n).padStart(9, '0')}`, passwordHash: 'x' } });
    const sentPromoter = await prisma.user.create({ data: { email: `s${n}@x.com`, phoneE164: `+23483${String(n).padStart(9, '0')}`, passwordHash: 'x' } });
    const dChan = await prisma.channel.create({ data: { promoterId: declinedPromoter.id, platform: Platform.X, claimedAudience: 100, effectiveReach: 5, status: ChannelStatus.ACTIVE } });
    const sChan = await prisma.channel.create({ data: { promoterId: sentPromoter.id, platform: Platform.X, claimedAudience: 100, effectiveReach: 5, status: ChannelStatus.ACTIVE } });
    await prisma.offer.create({ data: { campaignId: campaign.id, promoterId: declinedPromoter.id, channelId: dChan.id, role: PromoterRole.DISTRIBUTOR, feeMinor: FEE, expiresAt: new Date(Date.now() + 1e6), status: OfferStatus.DECLINED } });
    await prisma.offer.create({ data: { campaignId: campaign.id, promoterId: sentPromoter.id, channelId: sChan.id, role: PromoterRole.DISTRIBUTOR, feeMinor: FEE, expiresAt: new Date(Date.now() + 1e6), status: OfferStatus.SENT } });

    const assignment = await prisma.assignment.create({
      data: { offerId: acceptedOffer.id, campaignId: campaign.id, promoterId: promoter.id, channelId: channel.id, slotId: slot.id, role: PromoterRole.DISTRIBUTOR, feeMinor: FEE, trackingToken: token, status: AssignmentStatus.PAID },
    });
    await prisma.trackingLink.create({ data: { token, assignmentId: assignment.id, destinationUrl: 'https://x.example/go' } });

    const file = await prisma.file.create({ data: { storageKey: `k/${n}`, bucket: 'b', mimeType: 'image/png', sizeBytes: 10, checksumSha256: 'x' } });
    const submission = await prisma.submission.create({ data: { assignmentId: assignment.id, verdict: Verdict.APPROVED, publicUrl: 'https://insta/p/1' } });
    await prisma.proofArtifact.create({ data: { submissionId: submission.id, fileId: file.id, phash: 'abc' } });

    // Pay the promoter: DR escrow (fee+take), CR promoter (fee), CR revenue (take).
    await postTxn(LedgerTransactionKind.SUBMISSION_PAYOUT, submission.id, [
      { accountId: escrow.id, direction: EntryDirection.DEBIT, amountMinor: UNIT },
      { accountId: promoterAcct.id, direction: EntryDirection.CREDIT, amountMinor: FEE },
      { accountId: revenue.id, direction: EntryDirection.CREDIT, amountMinor: TAKE },
    ]);

    // Refund the unspent escrow (DR escrow / CR client wallet). This also debits
    // escrow, so "spent" must exclude it — only SUBMISSION_PAYOUT counts.
    await postTxn(LedgerTransactionKind.CAMPAIGN_REFUND, campaign.id, [
      { accountId: escrow.id, direction: EntryDirection.DEBIT, amountMinor: REFUND },
      { accountId: wallet.id, direction: EntryDirection.CREDIT, amountMinor: REFUND },
    ]);

    // Clicks: real ones + bots. Bots must not count toward views.
    const clicks = [];
    for (let i = 0; i < opts.nonBotClicks; i++) clicks.push({ token, ipHash: `ip${i}`, uaHash: `ua${i}`, isBot: false });
    for (let i = 0; i < opts.botClicks; i++) clicks.push({ token, ipHash: `bip${i}`, uaHash: `bua${i}`, isBot: true });
    if (clicks.length) await prisma.clickEvent.createMany({ data: clicks });

    return { ownerId: owner.id, campaignId: campaign.id, promoterId: promoter.id };
  }

  async function postTxn(kind: LedgerTransactionKind, refId: string, entries: { accountId: string; direction: EntryDirection; amountMinor: bigint }[]) {
    await prisma.ledgerTransaction.create({
      data: { kind, referenceType: 'test', referenceId: refId, idempotencyKey: randomUUID(), entries: { create: entries } },
    });
  }

  // ── Campaign analytics ───────────────────────────────────

  it('reports spent, views, cost-per-view, acceptance and completion correctly', async () => {
    const { ownerId, campaignId } = await seedCampaign({ nonBotClicks: 5, botClicks: 3 });

    const res = await http().get(`/campaigns/${campaignId}/analytics`).set(bearer(ownerId, [Role.CLIENT])).expect(200);

    expect(res.body.spent.amount_minor).toBe(Number(UNIT)); // one payout of 3450 left escrow
    expect(res.body.budget.amount_minor).toBe(Number(UNIT));
    expect(res.body.views_delivered).toBe(5); // 3 bot clicks excluded
    expect(res.body.cost_per_view.amount_minor).toBe(690); // 3450 / 5
    expect(res.body.offers_sent).toBe(3);
    expect(res.body.offers_accepted).toBe(1);
    expect(res.body.acceptance_rate).toBe(0.33); // 1/3
    expect(res.body.completed).toBe(1);
    expect(res.body.slots_total).toBe(1);
  });

  it('returns the evidence gallery with per-promoter view counts', async () => {
    const { ownerId, campaignId } = await seedCampaign({ nonBotClicks: 5, botClicks: 3 });
    const res = await http().get(`/campaigns/${campaignId}/analytics`).set(bearer(ownerId, [Role.CLIENT])).expect(200);

    expect(res.body.evidence).toHaveLength(1);
    const item = res.body.evidence[0];
    expect(item.promoter_name).toBe('Adaeze Okafor');
    expect(item.promoter_handle).toBe('@adaeze');
    expect(item.platform).toBe('INSTAGRAM');
    expect(item.views).toBe(5);
    expect(item.verdict).toBe('APPROVED');
    expect(item.auto_flag).toBe(false);
    expect(item.image_url).toBeTruthy();
  });

  it('cost-per-view is zero when there are no views yet', async () => {
    const { ownerId, campaignId } = await seedCampaign({ nonBotClicks: 0, botClicks: 2 });
    const res = await http().get(`/campaigns/${campaignId}/analytics`).set(bearer(ownerId, [Role.CLIENT])).expect(200);
    expect(res.body.views_delivered).toBe(0);
    expect(res.body.cost_per_view.amount_minor).toBe(0);
  });

  // ── Dashboard summary ────────────────────────────────────

  it('summarises the client’s campaigns for the dashboard', async () => {
    const { ownerId, campaignId } = await seedCampaign({ nonBotClicks: 5, botClicks: 3 });
    const res = await http().get('/dashboard/summary').set(bearer(ownerId, [Role.CLIENT])).expect(200);

    expect(res.body.campaigns_total).toBe(1);
    expect(res.body.live_campaigns).toBe(1);
    expect(res.body.views_delivered).toBe(5);
    expect(res.body.spent_this_month.amount_minor).toBe(Number(UNIT));
    expect(res.body.spent_change_pct).toBeNull(); // no spend last month
    expect(res.body.promoters_worked_with).toBe(1);
    expect(res.body.new_evidence_today).toBe(1);
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0].id).toBe(campaignId);
    expect(res.body.campaigns[0].spent.amount_minor).toBe(Number(UNIT));
    expect(res.body.campaigns[0].views).toBe(5);
    expect(res.body.campaigns[0].completed).toBe(1);
  });

  // ── Access control ───────────────────────────────────────

  it('a client cannot see another client’s campaign analytics', async () => {
    const a = await seedCampaign({ nonBotClicks: 1, botClicks: 0 });
    const b = await seedCampaign({ nonBotClicks: 1, botClicks: 0 });
    await http().get(`/campaigns/${a.campaignId}/analytics`).set(bearer(b.ownerId, [Role.CLIENT])).expect(404);
  });

  it('a promoter cannot reach client analytics', async () => {
    const { campaignId, promoterId } = await seedCampaign({ nonBotClicks: 1, botClicks: 0 });
    await http().get(`/campaigns/${campaignId}/analytics`).set(bearer(promoterId, [Role.PROMOTER])).expect(403);
    await http().get('/dashboard/summary').set(bearer(promoterId, [Role.PROMOTER])).expect(403);
  });

  it('requires authentication', async () => {
    const { campaignId } = await seedCampaign({ nonBotClicks: 1, botClicks: 0 });
    await http().get(`/campaigns/${campaignId}/analytics`).expect(401);
    await http().get('/dashboard/summary').expect(401);
  });
});
