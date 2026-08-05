import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AccountKind, CampaignObjective, CampaignStatus, EntryDirection, PromoterRole, PrismaClient, Role, SlotStatus } from '@prisma/client';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { RolesGuard } from '../../common/auth/roles.guard';
import { IdempotencyGuard } from '../../common/idempotency/idempotency.guard';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaymentsModule } from './payments.module';
import { PaystackService, type PaystackVerification } from './paystack.service';
import { testPrisma } from '../../../test/test-db';

/**
 * The Paystack HTTP call is stubbed — the value under test is that money moves
 * only when Paystack confirms success AND the amount matches, and that a
 * reference can never fund twice.
 */
class StubPaystack {
  next: PaystackVerification = { status: 'success', amountMinor: 0, currency: 'NGN', reference: 'x' };
  async verify(reference: string): Promise<PaystackVerification> {
    return { ...this.next, reference };
  }
  // In tests a signature is "valid" iff it equals the literal 'good' — the real HMAC
  // is exercised by PaystackService itself; here we test the routing/funding.
  verifySignature(_rawBody: Buffer, signature: string | undefined): boolean {
    return signature === 'good';
  }
}

describe('payments — Paystack verify + fund', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let jwt: JwtService;
  let paystack: StubPaystack;
  let seq = 0;

  const PRICE = 862500n;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET ??= 'test_access_secret';
    prisma = testPrisma();
    paystack = new StubPaystack();

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({}), PrismaModule, PaymentsModule],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: IdempotencyGuard },
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(PaystackService)
      .useValue(paystack)
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
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
      'TRUNCATE users, user_roles, client_orgs, campaigns, campaign_slots, accounts, ledger_transactions, ledger_entries, audit_log RESTART IDENTITY CASCADE',
    );
    await prisma.account.create({ data: { kind: AccountKind.BANK_CLEARING } });
    paystack.next = { status: 'success', amountMinor: Number(PRICE), currency: 'NGN', reference: 'x' };
  });

  const http = () => request(app.getHttpServer());
  const bearer = (id: string) => ({ Authorization: `Bearer ${jwt.sign({ sub: id, roles: [Role.CLIENT] }, { secret: process.env.JWT_ACCESS_SECRET })}` });
  const key = () => ({ 'Idempotency-Key': randomUUID() });

  async function quotedCampaign(): Promise<{ ownerId: string; campaignId: string }> {
    const n = seq++;
    const owner = await prisma.user.create({ data: { email: `c${n}@x.com`, phoneE164: `+23480${String(n).padStart(9, '0')}`, passwordHash: 'x', status: 'ACTIVE', roles: { create: { role: Role.CLIENT } } } });
    const org = await prisma.clientOrg.create({ data: { ownerUserId: owner.id, name: `Org${n}` } });
    const campaign = await prisma.campaign.create({
      data: {
        clientOrgId: org.id, name: `C${n}`, objective: CampaignObjective.AWARENESS, destinationUrl: 'https://x.example',
        status: CampaignStatus.QUOTED, budgetMinor: PRICE, priceMinor: PRICE, slotsTotal: 1, quotedAt: new Date(),
        slots: { create: [{ role: PromoterRole.DISTRIBUTOR, unitPriceMinor: PRICE, status: SlotStatus.OPEN }] },
      },
    });
    return { ownerId: owner.id, campaignId: campaign.id };
  }

  async function escrowBalance(campaignId: string): Promise<bigint> {
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    if (!c.escrowAccountId) return 0n;
    const rows = await prisma.ledgerEntry.groupBy({ by: ['direction'], where: { accountId: c.escrowAccountId }, _sum: { amountMinor: true } });
    let d = 0n, cr = 0n;
    for (const r of rows) { if (r.direction === EntryDirection.DEBIT) d = r._sum.amountMinor ?? 0n; else cr = r._sum.amountMinor ?? 0n; }
    return cr - d;
  }

  it('funds the campaign and goes LIVE when Paystack confirms the exact amount', async () => {
    const { ownerId, campaignId } = await quotedCampaign();
    const res = await http().post(`/campaigns/${campaignId}/payments/paystack/verify`).set(bearer(ownerId)).set(key())
      .send({ reference: 'RLA-abc-123' }).expect(200);

    expect(res.body.status).toBe('LIVE');
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.LIVE);
    expect(campaign.escrowAccountId).not.toBeNull();
    expect(await escrowBalance(campaignId)).toBe(PRICE);
    expect(await prisma.ledgerTransaction.count({ where: { kind: 'CAMPAIGN_FUNDING' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'campaign.fund.paystack' } })).toBe(1);

    // A reconciliation row opens, linked to the funding ledger transaction (§10).
    const gp = await prisma.gatewayPayment.findUniqueOrThrow({ where: { reference: 'RLA-abc-123' } });
    expect(gp.status).toBe('RECORDED');
    expect(gp.expectedMinor).toBe(PRICE);
    expect(gp.gatewayMinor).toBe(PRICE);
    expect(gp.ledgerTransactionId).not.toBeNull();
  });

  it('rejects a payment whose amount does not match the price', async () => {
    const { ownerId, campaignId } = await quotedCampaign();
    paystack.next = { status: 'success', amountMinor: Number(PRICE) - 100, currency: 'NGN', reference: 'x' };
    await http().post(`/campaigns/${campaignId}/payments/paystack/verify`).set(bearer(ownerId)).set(key())
      .send({ reference: 'RLA-abc-124' }).expect(400);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(CampaignStatus.QUOTED);
    expect(await prisma.ledgerTransaction.count()).toBe(0);
  });

  it('rejects a payment Paystack did not mark successful', async () => {
    const { ownerId, campaignId } = await quotedCampaign();
    paystack.next = { status: 'failed', amountMinor: Number(PRICE), currency: 'NGN', reference: 'x' };
    await http().post(`/campaigns/${campaignId}/payments/paystack/verify`).set(bearer(ownerId)).set(key())
      .send({ reference: 'RLA-abc-125' }).expect(400);
    expect(await prisma.ledgerTransaction.count()).toBe(0);
  });

  it('is idempotent on the Paystack reference — same reference funds once', async () => {
    const { ownerId, campaignId } = await quotedCampaign();
    const ref = 'RLA-dup-777';
    for (let i = 0; i < 3; i++) {
      await http().post(`/campaigns/${campaignId}/payments/paystack/verify`).set(bearer(ownerId)).set(key())
        .send({ reference: ref }).expect(200);
    }
    expect(await escrowBalance(campaignId)).toBe(PRICE);
    expect(await prisma.ledgerTransaction.count({ where: { kind: 'CAMPAIGN_FUNDING' } })).toBe(1);
    // The reconciliation row opens exactly once, too.
    expect(await prisma.gatewayPayment.count({ where: { reference: ref } })).toBe(1);
  });

  it('requires an Idempotency-Key', async () => {
    const { ownerId, campaignId } = await quotedCampaign();
    await http().post(`/campaigns/${campaignId}/payments/paystack/verify`).set(bearer(ownerId))
      .send({ reference: 'x' }).expect(400);
  });

  it('a client cannot fund another client’s campaign', async () => {
    const a = await quotedCampaign();
    const b = await quotedCampaign();
    await http().post(`/campaigns/${a.campaignId}/payments/paystack/verify`).set(bearer(b.ownerId)).set(key())
      .send({ reference: 'RLA-x' }).expect(404);
  });

  it('cannot fund a campaign that is not awaiting payment', async () => {
    const { ownerId, campaignId } = await quotedCampaign();
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: CampaignStatus.LIVE } });
    await http().post(`/campaigns/${campaignId}/payments/paystack/verify`).set(bearer(ownerId)).set(key())
      .send({ reference: 'RLA-y' }).expect(409);
  });

  // ── Webhook backstop ─────────────────────────────────────

  const webhook = (body: unknown, signature: string) =>
    http().post('/payments/paystack/webhook').set('x-paystack-signature', signature).send(body as object);

  it('a signed charge.success webhook funds the campaign even without the client callback', async () => {
    const { campaignId } = await quotedCampaign();

    await webhook({ event: 'charge.success', data: { reference: 'RLA-hook-1', metadata: { campaign_id: campaignId } } }, 'good').expect(200);

    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(c.status).toBe(CampaignStatus.LIVE);
    expect(await escrowBalance(campaignId)).toBe(PRICE);
  });

  it('rejects a webhook with a bad signature and moves no money', async () => {
    const { campaignId } = await quotedCampaign();

    await webhook({ event: 'charge.success', data: { reference: 'RLA-hook-2', metadata: { campaign_id: campaignId } } }, 'forged').expect(401);

    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe(CampaignStatus.QUOTED);
  });

  it('ignores a non-charge.success event', async () => {
    const { campaignId } = await quotedCampaign();

    await webhook({ event: 'charge.failed', data: { reference: 'RLA-hook-3', metadata: { campaign_id: campaignId } } }, 'good').expect(200);

    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe(CampaignStatus.QUOTED);
  });

  it('is idempotent with the client verify — the same reference funds once', async () => {
    const { ownerId, campaignId } = await quotedCampaign();
    await http().post(`/campaigns/${campaignId}/payments/paystack/verify`).set(bearer(ownerId)).set(key())
      .send({ reference: 'RLA-hook-4' }).expect(200);

    // The webhook arrives for the same reference — must not double-credit.
    await webhook({ event: 'charge.success', data: { reference: 'RLA-hook-4', metadata: { campaign_id: campaignId } } }, 'good').expect(200);

    expect(await escrowBalance(campaignId)).toBe(PRICE);
  });
});
