import { AccountKind, EntryDirection, PrismaClient } from '@prisma/client';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { resetLedger, testPrisma } from '../../../test/test-db';
import { ACCOUNT_RULES } from './account-rules';
import { InsufficientFundsError, LedgerService } from './ledger.service';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Handoff §10: "across thousands of random fund/approve/reject/withdraw/refund
 * sequences, every transaction balances and no account that must be non-negative
 * goes negative."
 *
 * This is the test the whole ledger exists to pass.
 *
 * Each run gets fresh accounts and tags its postings with a run id, so runs are
 * isolated without TRUNCATE between them — the exclusive lock TRUNCATE takes
 * dominated the runtime and made "thousands" unaffordable.
 */

type Op =
  | { type: 'fund'; amount: bigint }
  | { type: 'approve'; fee: bigint; take: bigint }
  | { type: 'withdraw'; amount: bigint }
  | { type: 'refund'; amount: bigint };

const RUNS = Number(process.env.LEDGER_PROPERTY_RUNS ?? 2000);

describe('ledger — property', () => {
  let prisma: PrismaClient;
  let ledger: LedgerService;

  beforeAll(async () => {
    prisma = testPrisma();
    ledger = new LedgerService(prisma as unknown as PrismaService);
    await resetLedger(prisma);
    // BANK_CLEARING and RALIA_REVENUE are singletons that the commands resolve
    // globally, exactly as in production. Creating one per run would be a lie:
    // getPlatformAccountId would hand every run the first one anyway.
    await ledger.createAccount(AccountKind.BANK_CLEARING);
    await ledger.createAccount(AccountKind.RALIA_REVENUE);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Balances for a set of named accounts, in one round trip. */
  async function balances(ids: Record<string, string>): Promise<Record<string, bigint>> {
    const accounts = await prisma.account.findMany({ where: { id: { in: Object.values(ids) } } });
    const kindOf = new Map(accounts.map((a) => [a.id, a.kind]));

    const rows = await prisma.ledgerEntry.groupBy({
      by: ['accountId', 'direction'],
      where: { accountId: { in: Object.values(ids) } },
      _sum: { amountMinor: true },
    });

    const out: Record<string, bigint> = {};
    for (const [name, id] of Object.entries(ids)) {
      const kind = kindOf.get(id)!;
      let debits = 0n;
      let credits = 0n;
      for (const row of rows.filter((r) => r.accountId === id)) {
        const total = row._sum.amountMinor ?? 0n;
        if (row.direction === EntryDirection.DEBIT) debits = total;
        else credits = total;
      }
      out[name] =
        ACCOUNT_RULES[kind].normal === EntryDirection.CREDIT ? credits - debits : debits - credits;
    }
    return out;
  }

  /** Net balance across every account of a kind. */
  async function totalByKind(kind: AccountKind): Promise<bigint> {
    const accounts = await prisma.account.findMany({ where: { kind }, select: { id: true } });
    const ids = accounts.map((a) => a.id);
    if (ids.length === 0) return 0n;

    const rows = await prisma.ledgerEntry.groupBy({
      by: ['direction'],
      where: { accountId: { in: ids } },
      _sum: { amountMinor: true },
    });

    let debits = 0n;
    let credits = 0n;
    for (const row of rows) {
      const total = row._sum.amountMinor ?? 0n;
      if (row.direction === EntryDirection.DEBIT) debits = total;
      else credits = total;
    }
    return ACCOUNT_RULES[kind].normal === EntryDirection.CREDIT ? credits - debits : debits - credits;
  }

  const amount = fc.bigInt({ min: 1n, max: 5_000_00n });

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ type: fc.constant('fund' as const), amount }),
    fc.record({ type: fc.constant('approve' as const), fee: amount, take: amount }),
    fc.record({ type: fc.constant('withdraw' as const), amount }),
    fc.record({ type: fc.constant('refund' as const), amount }),
  );

  it(
    'every transaction balances and no constrained account goes negative',
    async () => {
      let rejections = 0;

      await fc.assert(
        fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 12 }), async (ops) => {
          const runId = randomUUID();
          const ids = {
            escrow: randomUUID(),
            promoter: randomUUID(),
            wallet: randomUUID(),
          };
          await prisma.account.createMany({
            data: [
              { id: ids.escrow, kind: AccountKind.CAMPAIGN_ESCROW },
              { id: ids.promoter, kind: AccountKind.PROMOTER_AVAILABLE },
              { id: ids.wallet, kind: AccountKind.CLIENT_WALLET },
            ],
          });

          for (const op of ops) {
            const key = randomUUID();
            try {
              switch (op.type) {
                case 'fund':
                  await ledger.fundCampaign({
                    campaignId: runId, escrowAccountId: ids.escrow,
                    amountMinor: op.amount, idempotencyKey: key,
                  });
                  break;
                case 'approve':
                  await ledger.payoutSubmission({
                    submissionId: runId, escrowAccountId: ids.escrow, promoterAccountId: ids.promoter,
                    feeMinor: op.fee, takeMinor: op.take, idempotencyKey: key,
                  });
                  break;
                case 'withdraw':
                  await ledger.payWithdrawal({
                    withdrawalId: runId, promoterAccountId: ids.promoter,
                    amountMinor: op.amount, idempotencyKey: key,
                  });
                  break;
                case 'refund':
                  await ledger.refundCampaign({
                    campaignId: runId, escrowAccountId: ids.escrow, clientWalletAccountId: ids.wallet,
                    amountMinor: op.amount, idempotencyKey: key,
                  });
                  break;
              }
            } catch (e) {
              // A rejected posting is a correct outcome (withdrawing more than
              // earned, for one). It must leave no trace — the assertions below
              // hold regardless. Any other error is a real failure.
              if (!(e instanceof InsufficientFundsError)) throw e;
              rejections++;
            }
          }

          // ── Invariant 1: every persisted transaction balances ──
          const transactions = await prisma.ledgerTransaction.findMany({
            where: { referenceId: runId },
            include: { entries: true },
          });
          for (const txn of transactions) {
            const debits = txn.entries
              .filter((e) => e.direction === EntryDirection.DEBIT)
              .reduce((s, e) => s + e.amountMinor, 0n);
            const credits = txn.entries
              .filter((e) => e.direction === EntryDirection.CREDIT)
              .reduce((s, e) => s + e.amountMinor, 0n);
            expect(debits).toBe(credits);
          }

          // ── Invariant 2: constrained accounts never negative ──
          const bal = await balances(ids);
          expect(bal.escrow! >= 0n).toBe(true);
          expect(bal.promoter! >= 0n).toBe(true);
          expect(bal.wallet! >= 0n).toBe(true);

          return true;
        }),
        { numRuns: RUNS },
      );

      // ── Invariant 3: the books close, across every account of every run. ──
      // BANK_CLEARING is debit-normal; the rest are credit-normal. Cash held must
      // equal everything Ralia owes plus everything it has earned.
      const bank = await totalByKind(AccountKind.BANK_CLEARING);
      const owed =
        (await totalByKind(AccountKind.RALIA_REVENUE)) +
        (await totalByKind(AccountKind.CAMPAIGN_ESCROW)) +
        (await totalByKind(AccountKind.PROMOTER_AVAILABLE)) +
        (await totalByKind(AccountKind.CLIENT_WALLET));
      expect(bank).toBe(owed);

      // If nothing was ever rejected, the generator never produced an overdraw
      // and invariant 2 was proved only against sequences that could not violate it.
      expect(rejections).toBeGreaterThan(0);
    },
    15 * 60 * 1000,
  );

  it('rejects a transaction that does not balance', async () => {
    const a = await ledger.createAccount(AccountKind.CAMPAIGN_ESCROW);
    const b = await ledger.createAccount(AccountKind.BANK_CLEARING);

    await expect(
      ledger.post({
        kind: 'ADJUSTMENT',
        referenceType: 'test',
        referenceId: randomUUID(),
        idempotencyKey: randomUUID(),
        entries: [
          { accountId: b, direction: EntryDirection.DEBIT, amountMinor: 100n },
          { accountId: a, direction: EntryDirection.CREDIT, amountMinor: 99n },
        ],
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it('rejects a zero entry amount', async () => {
    const a = await ledger.createAccount(AccountKind.CAMPAIGN_ESCROW);
    const b = await ledger.createAccount(AccountKind.BANK_CLEARING);

    await expect(
      ledger.post({
        kind: 'ADJUSTMENT',
        referenceType: 'test',
        referenceId: randomUUID(),
        idempotencyKey: randomUUID(),
        entries: [
          { accountId: b, direction: EntryDirection.DEBIT, amountMinor: 0n },
          { accountId: a, direction: EntryDirection.CREDIT, amountMinor: 0n },
        ],
      }),
    ).rejects.toThrow(/must be positive/);
  });

  it('leaves no partial posting when the non-negative check fails', async () => {
    const runId = randomUUID();
    const escrow = await ledger.createAccount(AccountKind.CAMPAIGN_ESCROW);
    const promoter = await ledger.createAccount(AccountKind.PROMOTER_AVAILABLE);
    await ledger.createAccount(AccountKind.RALIA_REVENUE);

    // Escrow is empty; paying out must fail and roll back cleanly.
    await expect(
      ledger.payoutSubmission({
        submissionId: runId, escrowAccountId: escrow, promoterAccountId: promoter,
        feeMinor: 1000n, takeMinor: 500n, idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(InsufficientFundsError);

    expect(await prisma.ledgerTransaction.count({ where: { referenceId: runId } })).toBe(0);
    expect(await ledger.getBalance(escrow)).toBe(0n);
    expect(await ledger.getBalance(promoter)).toBe(0n);
  });

  it('balance is derived, so it survives a recount from entries alone', async () => {
    const escrow = await ledger.createAccount(AccountKind.CAMPAIGN_ESCROW);

    await ledger.fundCampaign({
      campaignId: randomUUID(), escrowAccountId: escrow,
      amountMinor: 250_000n, idempotencyKey: randomUUID(),
    });

    const viaService = await ledger.getBalance(escrow);
    const entries = await prisma.ledgerEntry.findMany({ where: { accountId: escrow } });
    const byHand = entries.reduce(
      (sum, e) =>
        e.direction === ACCOUNT_RULES.CAMPAIGN_ESCROW.normal ? sum + e.amountMinor : sum - e.amountMinor,
      0n,
    );

    expect(viaService).toBe(byHand);
    expect(viaService).toBe(250_000n);
  });
});
