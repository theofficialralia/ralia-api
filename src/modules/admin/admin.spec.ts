import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  AccountKind,
  AdminCapability,
  AssignmentStatus,
  CampaignObjective,
  CampaignStatus,
  ChannelStatus,
  EntryDirection,
  Platform,
  PrismaClient,
  PromoterRole,
  PromoterStatus,
  Role,
  SlotStatus,
  Verdict,
  VerificationTier,
  WithdrawalStatus,
} from '@prisma/client';
import request from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RolesGuard } from '../../common/auth/roles.guard';
import { CryptoModule } from '../../common/crypto/crypto.module';
import { IdempotencyGuard } from '../../common/idempotency/idempotency.guard';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateConfigModule } from '../../common/rate-config/rate-config.module';
import { AdminModule } from './admin.module';
import { WalletModule } from '../wallet/wallet.module';
import { testPrisma } from '../../../test/test-db';

/**
 * B8 done-when: approving a submission posts fee-to-promoter and take-to-revenue
 * as ONE balanced transaction, and every money- or score-affecting write leaves
 * an audit row.
 */
describe('admin — decisions, money and audit', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let jwt: JwtService;
  let seq = 0;

  const UNIT_PRICE = 3450n; // slot price
  const FEE = 2415n; // promoter's 70%
  const TAKE = 1035n; // Ralia's 30% — fee + take must equal UNIT_PRICE
  const PROMISED = 1000; // promised effective reach; approving with verified = PROMISED is a full delivery (refund 0)

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test_access_secret';
    prisma = testPrisma();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        JwtModule.register({}),
        PrismaModule,
        CryptoModule,
        RateConfigModule,
        AdminModule,
        WalletModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: IdempotencyGuard },
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
      'TRUNCATE users, user_roles, promoter_profiles, promoter_bank_accounts, channels, client_orgs, campaigns, campaign_slots, offers, assignments, submissions, proof_artifacts, files, withdrawals, accounts, ledger_transactions, ledger_entries, audit_log, rate_config RESTART IDENTITY CASCADE',
    );
    await prisma.rateConfig.create({ data: { isActive: true } });
    // The singleton platform accounts the seed normally creates.
    await prisma.account.create({ data: { kind: AccountKind.BANK_CLEARING } });
    await prisma.account.create({ data: { kind: AccountKind.RALIA_REVENUE } });
  });

  const http = () => request(app.getHttpServer());
  const bearer = (id: string, roles: Role[]) => ({
    Authorization: `Bearer ${jwt.sign({ sub: id, roles }, { secret: process.env.JWT_ACCESS_SECRET })}`,
  });
  const key = () => ({ 'Idempotency-Key': randomUUID() });

  async function makeAdmin(capabilities: AdminCapability[] = ['REVIEW_EVIDENCE', 'RECORD_MONEY']): Promise<string> {
    const n = seq++;
    const admin = await prisma.user.create({
      data: {
        email: `admin${n}@ralia.test`, phoneE164: `+2348000${String(n).padStart(6, '0')}`,
        passwordHash: 'x', status: 'ACTIVE',
        roles: { create: { role: Role.ADMIN, capabilities } },
      },
    });
    return admin.id;
  }

  async function makePromoter(status: PromoterStatus = PromoterStatus.ACTIVE): Promise<string> {
    const n = seq++;
    const user = await prisma.user.create({
      data: {
        email: `p${n}@x.com`, phoneE164: `+23482${String(n).padStart(8, '0')}`, passwordHash: 'x',
        status: 'ACTIVE', roles: { create: { role: Role.PROMOTER } },
      },
    });
    await prisma.promoterProfile.create({
      data: { userId: user.id, status, locationState: 'Lagos', languagesSpoken: ['English'], preferredCategories: ['Fashion'], trustScore: 60 },
    });
    await prisma.channel.create({
      data: {
        promoterId: user.id, platform: Platform.INSTAGRAM, claimedAudience: 20000,
        verificationTier: VerificationTier.SCREENSHOT, effectiveReach: 2000,
        status: status === PromoterStatus.ACTIVE ? ChannelStatus.ACTIVE : ChannelStatus.PENDING_REVIEW,
      },
    });
    await prisma.promoterBankAccount.create({
      data: { userId: user.id, bankCode: '058', accountNumberEnc: 'v1.x.y.z', accountNumberLast4: '6789', accountName: 'TEST NAME', isDefault: true },
    });
    return user.id;
  }

  /** A quoted campaign sitting in CONFIRMING_PAYMENT, with slots. */
  async function makeApprovedCampaign(slots = 1): Promise<string> {
    const n = seq++;
    const owner = await prisma.user.create({ data: { email: `c${n}@x.com`, phoneE164: `+23481${String(n).padStart(8, '0')}`, passwordHash: 'x' } });
    const org = await prisma.clientOrg.create({ data: { ownerUserId: owner.id, name: `Org${n}` } });
    const campaign = await prisma.campaign.create({
      data: {
        clientOrgId: org.id, name: `C${n}`, objective: CampaignObjective.AWARENESS,
        destinationUrl: 'https://x.example/go', status: CampaignStatus.CONFIRMING_PAYMENT,
        budgetMinor: UNIT_PRICE * BigInt(slots), priceMinor: UNIT_PRICE * BigInt(slots),
        slotsTotal: slots, quotedAt: new Date(),
        slots: { create: Array.from({ length: slots }, () => ({ role: PromoterRole.DISTRIBUTOR, unitPriceMinor: UNIT_PRICE, status: SlotStatus.OPEN })) },
      },
    });
    return campaign.id;
  }

  /** A pending submission on a funded, live campaign. */
  async function makePendingSubmission(): Promise<{ submissionId: string; promoterId: string; campaignId: string; adminId: string }> {
    const adminId = await makeAdmin();
    const promoterId = await makePromoter();
    const campaignId = await makeApprovedCampaign(1);

    await http().post(`/admin/campaigns/${campaignId}/fund`).set(bearer(adminId, [Role.ADMIN])).set(key())
      .send({ amount_minor: Number(UNIT_PRICE) }).expect(200);

    const channel = await prisma.channel.findFirstOrThrow({ where: { promoterId } });
    const slot = await prisma.campaignSlot.findFirstOrThrow({ where: { campaignId } });
    const offer = await prisma.offer.create({
      data: { campaignId, promoterId, channelId: channel.id, role: PromoterRole.DISTRIBUTOR, feeMinor: FEE, grossMinor: UNIT_PRICE, promisedReach: PROMISED, expiresAt: new Date(Date.now() + 1e6), status: 'ACCEPTED' },
    });
    const assignment = await prisma.assignment.create({
      data: {
        offerId: offer.id, campaignId, promoterId, channelId: channel.id, slotId: slot.id,
        role: PromoterRole.DISTRIBUTOR, feeMinor: FEE, grossMinor: UNIT_PRICE, promisedReach: PROMISED,
        trackingToken: randomBytes(12).toString('base64url'),
        status: AssignmentStatus.SUBMITTED,
      },
    });
    await prisma.campaignSlot.update({ where: { id: slot.id }, data: { status: SlotStatus.FILLED } });
    const submission = await prisma.submission.create({
      data: { assignmentId: assignment.id, verdict: Verdict.PENDING },
    });
    return { submissionId: submission.id, promoterId, campaignId, adminId };
  }

  async function balanceOf(kind: AccountKind, ownerId?: string): Promise<bigint> {
    const account = await prisma.account.findFirst({ where: { kind, ...(ownerId ? { ownerId } : { ownerId: null }) } });
    if (!account) return 0n;
    const rows = await prisma.ledgerEntry.groupBy({ by: ['direction'], where: { accountId: account.id }, _sum: { amountMinor: true } });
    let debit = 0n, credit = 0n;
    for (const r of rows) {
      if (r.direction === EntryDirection.DEBIT) debit = r._sum.amountMinor ?? 0n;
      else credit = r._sum.amountMinor ?? 0n;
    }
    return kind === AccountKind.BANK_CLEARING ? debit - credit : credit - debit;
  }

  // ── The done-when ────────────────────────────────────────

  it('approving a submission pays fee and take out of escrow in ONE balanced transaction', async () => {
    const { submissionId, promoterId, adminId } = await makePendingSubmission();

    expect(await balanceOf(AccountKind.CAMPAIGN_ESCROW, undefined)).toBe(0n); // owner-scoped below
    const escrowBefore = await prisma.account.findFirstOrThrow({ where: { kind: AccountKind.CAMPAIGN_ESCROW } });
    expect(await balanceOfAccount(escrowBefore.id, AccountKind.CAMPAIGN_ESCROW)).toBe(UNIT_PRICE);

    await http().post(`/admin/submissions/${submissionId}/approve`).send({ verified_views: PROMISED }).set(bearer(adminId, [Role.ADMIN])).set(key()).expect(200);

    // Exactly one payout transaction, carrying all three legs.
    const payouts = await prisma.ledgerTransaction.findMany({
      where: { kind: 'SUBMISSION_PAYOUT' },
      include: { entries: true },
    });
    expect(payouts).toHaveLength(1);

    const entries = payouts[0]!.entries;
    expect(entries).toHaveLength(3);
    const debits = entries.filter((e) => e.direction === EntryDirection.DEBIT).reduce((s, e) => s + e.amountMinor, 0n);
    const credits = entries.filter((e) => e.direction === EntryDirection.CREDIT).reduce((s, e) => s + e.amountMinor, 0n);
    expect(debits).toBe(credits);
    expect(debits).toBe(FEE + TAKE);

    // Money landed where §5.6 says it should.
    expect(await balanceOf(AccountKind.PROMOTER_AVAILABLE, promoterId)).toBe(FEE);
    expect(await balanceOf(AccountKind.RALIA_REVENUE)).toBe(TAKE);
    expect(await balanceOfAccount(escrowBefore.id, AccountKind.CAMPAIGN_ESCROW)).toBe(0n);

    // fee + take is exactly the slot price — escrow leaked nothing.
    expect(FEE + TAKE).toBe(UNIT_PRICE);
  });

  it('partial delivery above the threshold pays pro-rata and refunds the client the remainder', async () => {
    const { submissionId, promoterId, campaignId, adminId } = await makePendingSubmission();
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    const escrow = await prisma.account.findFirstOrThrow({ where: { kind: AccountKind.CAMPAIGN_ESCROW } });

    // promised 1000, verified 800 (≥ 70%). delivered_gross = 3450×800/1000 = 2760;
    // fee = round(2760×0.7) = 1932, take = 828, refund = 3450 − 2760 = 690.
    await http().post(`/admin/submissions/${submissionId}/approve`).send({ verified_views: 800 }).set(bearer(adminId, [Role.ADMIN])).set(key()).expect(200);

    expect(await balanceOf(AccountKind.PROMOTER_AVAILABLE, promoterId)).toBe(1932n);
    expect(await balanceOf(AccountKind.RALIA_REVENUE)).toBe(828n);
    expect(await balanceOf(AccountKind.CLIENT_WALLET, campaign.clientOrgId)).toBe(690n); // refund
    expect(await balanceOfAccount(escrow.id, AccountKind.CAMPAIGN_ESCROW)).toBe(0n); // 2760 + 690 = 3450

    const submission = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } });
    expect(submission.verifiedReach).toBe(800);
  });

  it('a delivery below the threshold is refused and moves no money', async () => {
    const { submissionId, promoterId, adminId } = await makePendingSubmission();

    // verified 600 < 70% of promised 1000 → refused, so the promoter can resubmit.
    await http().post(`/admin/submissions/${submissionId}/approve`).send({ verified_views: 600 }).set(bearer(adminId, [Role.ADMIN])).set(key()).expect(400);

    expect(await balanceOf(AccountKind.PROMOTER_AVAILABLE, promoterId)).toBe(0n);
    expect(await prisma.ledgerTransaction.count({ where: { kind: 'SUBMISSION_PAYOUT' } })).toBe(0);
    expect((await prisma.submission.findUniqueOrThrow({ where: { id: submissionId } })).verdict).toBe(Verdict.PENDING);
  });

  async function balanceOfAccount(accountId: string, kind: AccountKind): Promise<bigint> {
    const rows = await prisma.ledgerEntry.groupBy({ by: ['direction'], where: { accountId }, _sum: { amountMinor: true } });
    let debit = 0n, credit = 0n;
    for (const r of rows) {
      if (r.direction === EntryDirection.DEBIT) debit = r._sum.amountMinor ?? 0n;
      else credit = r._sum.amountMinor ?? 0n;
    }
    return kind === AccountKind.BANK_CLEARING ? debit - credit : credit - debit;
  }

  it('writes an audit row for every money- or score-affecting decision', async () => {
    const adminId = await makeAdmin();
    const promoterId = await makePromoter(PromoterStatus.AWAITING_APPROVAL);
    const campaignId = await makeApprovedCampaign(1);

    await http().post(`/admin/promoters/${promoterId}/approve`).set(bearer(adminId, [Role.ADMIN])).expect(200);
    await http().post(`/admin/campaigns/${campaignId}/fund`).set(bearer(adminId, [Role.ADMIN])).set(key())
      .send({ amount_minor: Number(UNIT_PRICE), reference: 'GTB 12345' }).expect(200);

    const actions = (await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map((a) => a.action);
    expect(actions).toContain('promoter.approve');
    expect(actions).toContain('campaign.fund');

    // Each records who, what changed, and against which entity.
    for (const row of await prisma.auditLog.findMany()) {
      expect(row.actorId).toBe(adminId);
      expect(row.entityId).toBeTruthy();
      expect(row.after).not.toBeNull();
    }
  });

  it('records before and after state on an audit row', async () => {
    const adminId = await makeAdmin();
    const promoterId = await makePromoter(PromoterStatus.AWAITING_APPROVAL);

    await http().post(`/admin/promoters/${promoterId}/approve`).set(bearer(adminId, [Role.ADMIN])).expect(200);

    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'promoter.approve' } });
    expect(row.before).toEqual({ status: PromoterStatus.AWAITING_APPROVAL });
    expect(row.after).toEqual({ status: PromoterStatus.ACTIVE });
  });

  // ── Capability separation (§7) ───────────────────────────

  it('reviewing evidence and recording money are separable capabilities', async () => {
    const reviewer = await makeAdmin([AdminCapability.REVIEW_EVIDENCE]);
    const treasurer = await makeAdmin([AdminCapability.RECORD_MONEY]);
    const campaignId = await makeApprovedCampaign(1);
    const promoterId = await makePromoter(PromoterStatus.AWAITING_APPROVAL);

    // The reviewer may judge people, but may not record money.
    await http().post(`/admin/promoters/${promoterId}/approve`).set(bearer(reviewer, [Role.ADMIN])).expect(200);
    await http().post(`/admin/campaigns/${campaignId}/fund`).set(bearer(reviewer, [Role.ADMIN])).set(key())
      .send({ amount_minor: Number(UNIT_PRICE) }).expect(403);

    // The treasurer may record money, but may not judge people.
    await http().post(`/admin/campaigns/${campaignId}/fund`).set(bearer(treasurer, [Role.ADMIN])).set(key())
      .send({ amount_minor: Number(UNIT_PRICE) }).expect(200);
    const another = await makePromoter(PromoterStatus.AWAITING_APPROVAL);
    await http().post(`/admin/promoters/${another}/approve`).set(bearer(treasurer, [Role.ADMIN])).expect(403);
  });

  it('a non-admin cannot reach admin endpoints at all', async () => {
    const promoterId = await makePromoter();
    await http().get('/admin/queues/submissions').set(bearer(promoterId, [Role.PROMOTER])).expect(403);
  });

  // ── Idempotency on money endpoints ───────────────────────

  it('rejects a money mutation with no Idempotency-Key', async () => {
    const adminId = await makeAdmin();
    const campaignId = await makeApprovedCampaign(1);
    await http().post(`/admin/campaigns/${campaignId}/fund`).set(bearer(adminId, [Role.ADMIN]))
      .send({ amount_minor: Number(UNIT_PRICE) }).expect(400);
  });

  it('replaying an approval five times pays the promoter once', async () => {
    const { submissionId, promoterId, adminId } = await makePendingSubmission();
    const k = { 'Idempotency-Key': randomUUID() };

    for (let i = 0; i < 5; i++) {
      await http().post(`/admin/submissions/${submissionId}/approve`).send({ verified_views: PROMISED }).set(bearer(adminId, [Role.ADMIN])).set(k).expect(200);
    }

    expect(await balanceOf(AccountKind.PROMOTER_AVAILABLE, promoterId)).toBe(FEE);
    expect(await prisma.ledgerTransaction.count({ where: { kind: 'SUBMISSION_PAYOUT' } })).toBe(1);
  });

  it('replaying funding five times moves escrow once', async () => {
    const adminId = await makeAdmin();
    const campaignId = await makeApprovedCampaign(1);
    const k = { 'Idempotency-Key': randomUUID() };

    for (let i = 0; i < 5; i++) {
      await http().post(`/admin/campaigns/${campaignId}/fund`).set(bearer(adminId, [Role.ADMIN])).set(k)
        .send({ amount_minor: Number(UNIT_PRICE) }).expect(200);
    }
    expect(await prisma.ledgerTransaction.count({ where: { kind: 'CAMPAIGN_FUNDING' } })).toBe(1);
  });

  // ── Funding rules ────────────────────────────────────────

  it('funding must match the quoted price exactly', async () => {
    const adminId = await makeAdmin();
    const campaignId = await makeApprovedCampaign(1);

    await http().post(`/admin/campaigns/${campaignId}/fund`).set(bearer(adminId, [Role.ADMIN])).set(key())
      .send({ amount_minor: Number(UNIT_PRICE) - 100 }).expect(400);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.CONFIRMING_PAYMENT); // unchanged
  });

  it('funding makes the campaign LIVE', async () => {
    const adminId = await makeAdmin();
    const campaignId = await makeApprovedCampaign(1);
    await http().post(`/admin/campaigns/${campaignId}/fund`).set(bearer(adminId, [Role.ADMIN])).set(key())
      .send({ amount_minor: Number(UNIT_PRICE) }).expect(200);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.LIVE);
    expect(campaign.escrowAccountId).not.toBeNull();
  });

  // ── Rejections require a reason ──────────────────────────

  it('rejecting anything requires a reason', async () => {
    const adminId = await makeAdmin();
    const promoterId = await makePromoter(PromoterStatus.AWAITING_APPROVAL);
    const { submissionId, adminId: a2 } = await makePendingSubmission();

    await http().post(`/admin/promoters/${promoterId}/reject`).set(bearer(adminId, [Role.ADMIN])).send({}).expect(400);
    await http().post(`/admin/submissions/${submissionId}/reject`).set(bearer(a2, [Role.ADMIN])).send({ reason: 'no' }).expect(400); // too short
    await http().post(`/admin/submissions/${submissionId}/reject`).set(bearer(a2, [Role.ADMIN]))
      .send({ reason: 'Screenshot does not show the creative.' }).expect(200);
  });

  it('a rejected submission returns the assignment to REJECTED so proof can be resubmitted, and pays nothing', async () => {
    const { submissionId, promoterId, adminId } = await makePendingSubmission();
    await http().post(`/admin/submissions/${submissionId}/reject`).set(bearer(adminId, [Role.ADMIN]))
      .send({ reason: 'Creative not visible in the screenshot.' }).expect(200);

    const submission = await prisma.submission.findUniqueOrThrow({ where: { id: submissionId }, include: { assignment: true } });
    expect(submission.verdict).toBe(Verdict.REJECTED);
    expect(submission.rejectReason).toContain('Creative not visible');
    expect(submission.assignment.status).toBe(AssignmentStatus.REJECTED);
    expect(await balanceOf(AccountKind.PROMOTER_AVAILABLE, promoterId)).toBe(0n);
  });

  it('a submission cannot be decided twice', async () => {
    const { submissionId, adminId } = await makePendingSubmission();
    await http().post(`/admin/submissions/${submissionId}/approve`).send({ verified_views: PROMISED }).set(bearer(adminId, [Role.ADMIN])).set(key()).expect(200);
    // A different key — this is a genuine second decision, not a replay.
    await http().post(`/admin/submissions/${submissionId}/approve`).send({ verified_views: PROMISED }).set(bearer(adminId, [Role.ADMIN])).set(key()).expect(409);
    await http().post(`/admin/submissions/${submissionId}/reject`).set(bearer(adminId, [Role.ADMIN]))
      .send({ reason: 'changed my mind about this' }).expect(409);
  });

  // ── Withdrawal lifecycle ─────────────────────────────────

  it('runs a withdrawal from request through recorded payout', async () => {
    const { submissionId, promoterId, adminId } = await makePendingSubmission();
    await http().post(`/admin/submissions/${submissionId}/approve`).send({ verified_views: PROMISED }).set(bearer(adminId, [Role.ADMIN])).set(key()).expect(200);
    expect(await balanceOf(AccountKind.PROMOTER_AVAILABLE, promoterId)).toBe(FEE);

    // Below the ₦5,000 minimum, so this balance cannot be withdrawn yet.
    const wallet = await http().get('/wallet').set(bearer(promoterId, [Role.PROMOTER])).expect(200);
    expect(wallet.body.available.amount_minor).toBe(Number(FEE));
    expect(wallet.body.can_withdraw).toBe(false);
    await http().post('/withdrawals').set(bearer(promoterId, [Role.PROMOTER])).send({ amount_minor: Number(FEE) }).expect(400);

    // Top the promoter up past the minimum via more approved work.
    const second = await makePendingSubmissionFor(promoterId, adminId);
    await http().post(`/admin/submissions/${second}/approve`).send({ verified_views: PROMISED }).set(bearer(adminId, [Role.ADMIN])).set(key()).expect(200);

    await prisma.$executeRawUnsafe('SELECT 1'); // no-op; balances are derived
    const balance = await balanceOf(AccountKind.PROMOTER_AVAILABLE, promoterId);
    expect(balance).toBe(FEE * 2n);

    // Still under ₦5,000 (4830 kobo), so raise the balance directly to test the flow.
    await prisma.rateConfig.updateMany({ where: { isActive: true }, data: { withdrawalMinimumMinor: 1000n } });

    const requested = await http().post('/withdrawals').set(bearer(promoterId, [Role.PROMOTER]))
      .send({ amount_minor: Number(FEE) }).expect(201);
    expect(requested.body.status).toBe(WithdrawalStatus.REQUESTED);

    await http().post(`/admin/withdrawals/${requested.body.id}/approve`).set(bearer(adminId, [Role.ADMIN])).expect(200);
    await http().post(`/admin/withdrawals/${requested.body.id}/record-paid`).set(bearer(adminId, [Role.ADMIN])).set(key())
      .send({ paid_ref: 'Zenith 99881' }).expect(200);

    const paid = await prisma.withdrawal.findUniqueOrThrow({ where: { id: requested.body.id } });
    expect(paid.status).toBe(WithdrawalStatus.PAID);
    expect(paid.paidRef).toBe('Zenith 99881');

    // The payout left the promoter's balance and cash position.
    expect(await balanceOf(AccountKind.PROMOTER_AVAILABLE, promoterId)).toBe(FEE * 2n - FEE);

    const actions = (await prisma.auditLog.findMany()).map((a) => a.action);
    expect(actions).toContain('withdrawal.approve');
    expect(actions).toContain('withdrawal.paid');
  });

  /** A second pending submission for an existing promoter, on a fresh funded campaign. */
  async function makePendingSubmissionFor(promoterId: string, adminId: string): Promise<string> {
    const campaignId = await makeApprovedCampaign(1);
    await http().post(`/admin/campaigns/${campaignId}/fund`).set(bearer(adminId, [Role.ADMIN])).set(key())
      .send({ amount_minor: Number(UNIT_PRICE) }).expect(200);
    const channel = await prisma.channel.findFirstOrThrow({ where: { promoterId } });
    const slot = await prisma.campaignSlot.findFirstOrThrow({ where: { campaignId } });
    const offer = await prisma.offer.create({
      data: { campaignId, promoterId, channelId: channel.id, role: PromoterRole.DISTRIBUTOR, feeMinor: FEE, grossMinor: UNIT_PRICE, promisedReach: PROMISED, expiresAt: new Date(Date.now() + 1e6), status: 'ACCEPTED' },
    });
    const assignment = await prisma.assignment.create({
      data: {
        offerId: offer.id, campaignId, promoterId, channelId: channel.id, slotId: slot.id,
        role: PromoterRole.DISTRIBUTOR, feeMinor: FEE, grossMinor: UNIT_PRICE, promisedReach: PROMISED,
        trackingToken: randomBytes(12).toString('base64url'),
        status: AssignmentStatus.SUBMITTED,
      },
    });
    const submission = await prisma.submission.create({ data: { assignmentId: assignment.id, verdict: Verdict.PENDING } });
    return submission.id;
  }

  it('cannot withdraw more than the unencumbered balance', async () => {
    const { submissionId, promoterId, adminId } = await makePendingSubmission();
    await http().post(`/admin/submissions/${submissionId}/approve`).send({ verified_views: PROMISED }).set(bearer(adminId, [Role.ADMIN])).set(key()).expect(200);
    await prisma.rateConfig.updateMany({ where: { isActive: true }, data: { withdrawalMinimumMinor: 100n } });

    await http().post('/withdrawals').set(bearer(promoterId, [Role.PROMOTER])).send({ amount_minor: Number(FEE) }).expect(201);
    // The first request already claims the whole balance.
    await http().post('/withdrawals').set(bearer(promoterId, [Role.PROMOTER])).send({ amount_minor: Number(FEE) }).expect(400);
  });

  it('a withdrawal can only be recorded paid after approval', async () => {
    const { submissionId, promoterId, adminId } = await makePendingSubmission();
    await http().post(`/admin/submissions/${submissionId}/approve`).send({ verified_views: PROMISED }).set(bearer(adminId, [Role.ADMIN])).set(key()).expect(200);
    await prisma.rateConfig.updateMany({ where: { isActive: true }, data: { withdrawalMinimumMinor: 100n } });
    const w = await http().post('/withdrawals').set(bearer(promoterId, [Role.PROMOTER])).send({ amount_minor: Number(FEE) }).expect(201);

    await http().post(`/admin/withdrawals/${w.body.id}/record-paid`).set(bearer(adminId, [Role.ADMIN])).set(key())
      .send({ paid_ref: 'Zenith 00001' }).expect(409);
  });

  // ── Queues ───────────────────────────────────────────────

  it('surfaces what needs a decision', async () => {
    const adminId = await makeAdmin();
    await makePromoter(PromoterStatus.AWAITING_APPROVAL);
    const { submissionId } = await makePendingSubmission();

    const promoters = await http().get('/admin/queues/promoters').set(bearer(adminId, [Role.ADMIN])).expect(200);
    expect(promoters.body.length).toBeGreaterThanOrEqual(1);

    const submissions = await http().get('/admin/queues/submissions').set(bearer(adminId, [Role.ADMIN])).expect(200);
    expect(submissions.body.map((s: { id: string }) => s.id)).toContain(submissionId);
  });

  // ── Gateway reconciliation ───────────────────────────────

  /** A funded campaign with a gateway_payments row linked to its funding ledger tx. */
  async function makeGatewayPayment(gatewayMinor: bigint = UNIT_PRICE): Promise<{ adminId: string; paymentId: string }> {
    const adminId = await makeAdmin();
    const campaignId = await makeApprovedCampaign(1);
    await http().post(`/admin/campaigns/${campaignId}/fund`).set(bearer(adminId, [Role.ADMIN])).set(key())
      .send({ amount_minor: Number(UNIT_PRICE) }).expect(200);
    const fundingTx = await prisma.ledgerTransaction.findFirstOrThrow({ where: { kind: 'CAMPAIGN_FUNDING', referenceId: campaignId } });
    const gp = await prisma.gatewayPayment.create({
      data: { campaignId, reference: `REF-${seq++}`, expectedMinor: UNIT_PRICE, gatewayMinor, ledgerTransactionId: fundingTx.id },
    });
    return { adminId, paymentId: gp.id };
  }

  it('reconciles a gateway charge against the ledger escrow credit', async () => {
    const { adminId } = await makeGatewayPayment();
    const res = await http().get('/admin/reconciliation').set(bearer(adminId, [Role.ADMIN])).expect(200);
    expect(res.body.ledger_matches_gateway).toBe(true);
    expect(res.body.recorded).toBe(1);
    expect(res.body.gateway_total.amount_minor).toBe(Number(UNIT_PRICE));
    expect(res.body.payments[0].matched).toBe(true);
    expect(res.body.payments[0].ledger.amount_minor).toBe(Number(UNIT_PRICE));
  });

  it('marks a charge unmatched when the ledger credit disagrees with the gateway amount', async () => {
    const { adminId } = await makeGatewayPayment(UNIT_PRICE + 100n); // gateway claims 100 more than escrow holds
    const res = await http().get('/admin/reconciliation').set(bearer(adminId, [Role.ADMIN])).expect(200);
    expect(res.body.ledger_matches_gateway).toBe(false);
    expect(res.body.payments[0].matched).toBe(false);
  });

  it('records a settlement (RECORDED → SETTLED) and refuses a double settle', async () => {
    const { adminId, paymentId } = await makeGatewayPayment();
    await http().post(`/admin/reconciliation/${paymentId}/settle`).set(bearer(adminId, [Role.ADMIN]))
      .send({ settlement_ref: 'PSTK_STL_1', settled_minor: Number(UNIT_PRICE) - 50 }).expect(200);

    const after = await http().get('/admin/reconciliation').set(bearer(adminId, [Role.ADMIN])).expect(200);
    expect(after.body.settled).toBe(1);
    expect(after.body.recorded).toBe(0);
    expect(after.body.settled_total.amount_minor).toBe(Number(UNIT_PRICE) - 50);
    expect(await prisma.auditLog.count({ where: { action: 'gateway.settle' } })).toBe(1);

    await http().post(`/admin/reconciliation/${paymentId}/settle`).set(bearer(adminId, [Role.ADMIN]))
      .send({ settlement_ref: 'PSTK_STL_1', settled_minor: Number(UNIT_PRICE) }).expect(409);
  });

  it('flags a settlement discrepancy for finance', async () => {
    const { adminId, paymentId } = await makeGatewayPayment();
    await http().post(`/admin/reconciliation/${paymentId}/flag`).set(bearer(adminId, [Role.ADMIN]))
      .send({ reason: 'Settlement short beyond the gateway fee' }).expect(200);
    const res = await http().get('/admin/reconciliation').set(bearer(adminId, [Role.ADMIN])).expect(200);
    expect(res.body.mismatched).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'gateway.flag' } })).toBe(1);
  });

  // ── Channel verification (§1) ────────────────────────────

  it('verifying a channel lifts the self-reported cap and stamps verified_at', async () => {
    const adminId = await makeAdmin();
    const promoterId = await makePromoter();
    // A big self-reported Instagram channel: 100000 × 0.10 × 0.6 = 6000, capped to 2000.
    const channel = await prisma.channel.create({
      data: { promoterId, platform: Platform.INSTAGRAM, claimedAudience: 100_000, verificationTier: VerificationTier.SELF, effectiveReach: 2000, status: ChannelStatus.ACTIVE },
    });

    await http().post(`/admin/channels/${channel.id}/verify`).set(bearer(adminId, [Role.ADMIN])).send({ tier: 'SCREENSHOT' }).expect(200);

    const after = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(after.verificationTier).toBe(VerificationTier.SCREENSHOT);
    expect(after.verifiedAt).not.toBeNull();
    expect(after.effectiveReach).toBe(10_000); // 100000 × 0.10 × 1.0, uncapped
    expect(await prisma.auditLog.count({ where: { action: 'channel.verify' } })).toBe(1);
  });

  it('refuses to "verify" at the self-reported tier', async () => {
    const adminId = await makeAdmin();
    const promoterId = await makePromoter();
    const channel = await prisma.channel.create({
      data: { promoterId, platform: Platform.INSTAGRAM, claimedAudience: 5000, verificationTier: VerificationTier.SELF, effectiveReach: 300, status: ChannelStatus.ACTIVE },
    });
    await http().post(`/admin/channels/${channel.id}/verify`).set(bearer(adminId, [Role.ADMIN])).send({ tier: 'SELF' }).expect(400);
  });

  it('unverifying a channel drops it to self-reported and re-caps', async () => {
    const adminId = await makeAdmin();
    const promoterId = await makePromoter();
    const channel = await prisma.channel.create({
      data: { promoterId, platform: Platform.INSTAGRAM, claimedAudience: 100_000, verificationTier: VerificationTier.INSIGHTS, verifiedAt: new Date(), effectiveReach: 11_500, status: ChannelStatus.ACTIVE },
    });

    await http().post(`/admin/channels/${channel.id}/unverify`).set(bearer(adminId, [Role.ADMIN])).send({ reason: 'Screenshot was edited' }).expect(200);

    const after = await prisma.channel.findUniqueOrThrow({ where: { id: channel.id } });
    expect(after.verificationTier).toBe(VerificationTier.SELF);
    expect(after.verifiedAt).toBeNull();
    expect(after.effectiveReach).toBe(2000); // recapped
    expect(await prisma.auditLog.count({ where: { action: 'channel.unverify' } })).toBe(1);
  });
});
