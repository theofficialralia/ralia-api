import { AccountKind, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { resetLedger, testPrisma } from '../../../test/test-db';
import { LedgerService } from './ledger.service';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Handoff §10: "replaying any money mutation five times moves the balance once."
 */
describe('ledger — idempotency', () => {
  let prisma: PrismaClient;
  let ledger: LedgerService;
  let bank: string;
  let revenue: string;
  let escrow: string;
  let promoter: string;
  let wallet: string;

  beforeAll(() => {
    prisma = testPrisma();
    ledger = new LedgerService(prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetLedger(prisma);
    bank = await ledger.createAccount(AccountKind.BANK_CLEARING);
    revenue = await ledger.createAccount(AccountKind.RALIA_REVENUE);
    escrow = await ledger.createAccount(AccountKind.CAMPAIGN_ESCROW);
    promoter = await ledger.createAccount(AccountKind.PROMOTER_AVAILABLE);
    wallet = await ledger.createAccount(AccountKind.CLIENT_WALLET);
  });

  it('replaying fundCampaign five times moves the balance once', async () => {
    const key = randomUUID();
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        await ledger.fundCampaign({
          campaignId: 'c1', escrowAccountId: escrow, amountMinor: 100_000n, idempotencyKey: key,
        }),
      );
    }

    expect(await ledger.getBalance(escrow)).toBe(100_000n);
    expect(await prisma.ledgerTransaction.count()).toBe(1);
    expect(await prisma.ledgerEntry.count()).toBe(2);

    // Every replay returns the original transaction, flagged as a replay.
    const ids = new Set(results.map((r) => r.transactionId));
    expect(ids.size).toBe(1);
    expect(results.map((r) => r.replayed)).toEqual([false, true, true, true, true]);
  });

  it('replaying payoutSubmission five times moves the balance once', async () => {
    await ledger.fundCampaign({
      campaignId: 'c1', escrowAccountId: escrow, amountMinor: 500_000n, idempotencyKey: randomUUID(),
    });

    const key = randomUUID();
    for (let i = 0; i < 5; i++) {
      await ledger.payoutSubmission({
        submissionId: 's1', escrowAccountId: escrow, promoterAccountId: promoter,
        feeMinor: 70_000n, takeMinor: 30_000n, idempotencyKey: key,
      });
    }

    expect(await ledger.getBalance(promoter)).toBe(70_000n);
    expect(await ledger.getBalance(revenue)).toBe(30_000n);
    expect(await ledger.getBalance(escrow)).toBe(400_000n);
    expect(await prisma.ledgerTransaction.count()).toBe(2); // funding + one payout
  });

  it('replaying payWithdrawal and refundCampaign five times each moves the balance once', async () => {
    await ledger.fundCampaign({
      campaignId: 'c1', escrowAccountId: escrow, amountMinor: 500_000n, idempotencyKey: randomUUID(),
    });
    await ledger.payoutSubmission({
      submissionId: 's1', escrowAccountId: escrow, promoterAccountId: promoter,
      feeMinor: 70_000n, takeMinor: 30_000n, idempotencyKey: randomUUID(),
    });

    const withdrawKey = randomUUID();
    const refundKey = randomUUID();
    for (let i = 0; i < 5; i++) {
      await ledger.payWithdrawal({
        withdrawalId: 'w1', promoterAccountId: promoter, amountMinor: 50_000n, idempotencyKey: withdrawKey,
      });
      await ledger.refundCampaign({
        campaignId: 'c1', escrowAccountId: escrow, clientWalletAccountId: wallet,
        amountMinor: 25_000n, idempotencyKey: refundKey,
      });
    }

    expect(await ledger.getBalance(promoter)).toBe(20_000n);
    expect(await ledger.getBalance(wallet)).toBe(25_000n);
    expect(await ledger.getBalance(escrow)).toBe(375_000n);
  });

  it('concurrent replays of one key still move the balance once', async () => {
    // WhatsApp-style redelivery, or an admin double-clicking Fund: the same key
    // arrives several times at once, not in sequence.
    const key = randomUUID();
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        ledger.fundCampaign({
          campaignId: 'c1', escrowAccountId: escrow, amountMinor: 100_000n, idempotencyKey: key,
        }),
      ),
    );

    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    expect(fulfilled.length).toBe(8);
    expect(await ledger.getBalance(escrow)).toBe(100_000n);
    expect(await prisma.ledgerTransaction.count()).toBe(1);
  });

  it('rejects a key replayed with a different payload', async () => {
    const key = randomUUID();
    await ledger.fundCampaign({
      campaignId: 'c1', escrowAccountId: escrow, amountMinor: 100_000n, idempotencyKey: key,
    });

    // Same key, different amount — a client bug. Returning the original silently
    // would hide it.
    await expect(
      ledger.fundCampaign({
        campaignId: 'c1', escrowAccountId: escrow, amountMinor: 999_999n, idempotencyKey: key,
      }),
    ).rejects.toThrow(/already used for a different transaction/);

    expect(await ledger.getBalance(escrow)).toBe(100_000n);
  });

  it('distinct keys post distinctly', async () => {
    for (let i = 0; i < 3; i++) {
      await ledger.fundCampaign({
        campaignId: 'c1', escrowAccountId: escrow, amountMinor: 100_000n, idempotencyKey: randomUUID(),
      });
    }
    expect(await ledger.getBalance(escrow)).toBe(300_000n);
    expect(await prisma.ledgerTransaction.count()).toBe(3);
  });
});
