import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AccountKind,
  EntryDirection,
  LedgerTransactionKind,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ACCOUNT_RULES } from './account-rules';

export type EntryInput = {
  accountId: string;
  direction: EntryDirection;
  amountMinor: bigint;
};

export type PostInput = {
  kind: LedgerTransactionKind;
  referenceType: string;
  referenceId: string;
  /** Client-supplied. Replaying a key returns the original posting untouched. */
  idempotencyKey: string;
  memo?: string;
  createdBy?: string;
  entries: EntryInput[];
};

/** Thrown when a posting would drive a non-negative account below zero. */
export class InsufficientFundsError extends BadRequestException {
  constructor(
    readonly accountId: string,
    readonly kind: AccountKind,
    readonly attemptedBalance: bigint,
  ) {
    super(`${kind} ${accountId} would go to ${attemptedBalance}; it may not go negative`);
  }
}

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────
  // Balances — always derived. There is no balance column.
  // ─────────────────────────────────────────────────────────

  async getBalance(accountId: string, tx: Tx = this.prisma): Promise<bigint> {
    const account = await tx.account.findUnique({ where: { id: accountId } });
    if (!account) throw new NotFoundException(`No account ${accountId}`);
    return this.balanceOf(accountId, account.kind, tx);
  }

  private async balanceOf(accountId: string, kind: AccountKind, tx: Tx): Promise<bigint> {
    const sums = await tx.ledgerEntry.groupBy({
      by: ['direction'],
      where: { accountId },
      _sum: { amountMinor: true },
    });

    let debits = 0n;
    let credits = 0n;
    for (const row of sums) {
      const total = row._sum.amountMinor ?? 0n;
      if (row.direction === EntryDirection.DEBIT) debits = total;
      else credits = total;
    }

    return ACCOUNT_RULES[kind].normal === EntryDirection.CREDIT
      ? credits - debits
      : debits - credits;
  }

  // ─────────────────────────────────────────────────────────
  // The posting primitive — every money movement goes through here.
  // ─────────────────────────────────────────────────────────

  async post(input: PostInput): Promise<{ transactionId: string; replayed: boolean }> {
    this.validate(input);

    const accountIds = [...new Set(input.entries.map((e) => e.accountId))].sort();

    // Fast path: an already-committed key replays without opening a transaction
    // or touching account locks, so a flood of duplicate deliveries is cheap.
    const preExisting = await this.prisma.ledgerTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { entries: true },
    });
    if (preExisting) {
      this.assertReplayMatches(preExisting, input);
      return { transactionId: preExisting.id, replayed: true };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Claim the idempotency key FIRST. Concurrent duplicates block on this
        // unique index — not on the account rows — and lose fast with P2002, so
        // only the one winner ever contends for account locks.
        const created = await tx.ledgerTransaction.create({
          data: {
            kind: input.kind,
            referenceType: input.referenceType,
            referenceId: input.referenceId,
            idempotencyKey: input.idempotencyKey,
            memo: input.memo ?? null,
            createdBy: input.createdBy ?? null,
          },
        });

        // Winner only. Lock every account this posting touches, in a stable
        // order so two postings over the same accounts can't deadlock. This is
        // what makes the non-negative check safe: a racing posting cannot slip
        // between our writes and the check.
        await tx.$queryRaw`SELECT id FROM accounts WHERE id = ANY(${accountIds}::uuid[]) ORDER BY id FOR UPDATE`;

        const accounts = await tx.account.findMany({ where: { id: { in: accountIds } } });
        if (accounts.length !== accountIds.length) {
          const found = new Set(accounts.map((a) => a.id));
          const missing = accountIds.filter((id) => !found.has(id));
          throw new NotFoundException(`No such account(s): ${missing.join(', ')}`);
        }

        await tx.ledgerEntry.createMany({
          data: input.entries.map((e) => ({
            transactionId: created.id,
            accountId: e.accountId,
            direction: e.direction,
            amountMinor: e.amountMinor,
          })),
        });

        // Post first, then verify. Inside the lock these are indivisible, and
        // checking after means the constraint is evaluated against what the
        // ledger actually holds rather than a predicted value.
        for (const account of accounts) {
          if (!ACCOUNT_RULES[account.kind].nonNegative) continue;
          const balance = await this.balanceOf(account.id, account.kind, tx);
          if (balance < 0n) {
            throw new InsufficientFundsError(account.id, account.kind, balance);
          }
        }

        return { transactionId: created.id, replayed: false };
      });
    } catch (e) {
      // A concurrent request won the key race between our pre-check and our
      // insert. Re-read the committed transaction and return it as a replay.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.prisma.ledgerTransaction.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          include: { entries: true },
        });
        if (winner) {
          this.assertReplayMatches(winner, input);
          return { transactionId: winner.id, replayed: true };
        }
      }
      throw e;
    }
  }

  private validate(input: PostInput): void {
    if (input.entries.length < 2) {
      throw new BadRequestException('A transaction needs at least two entries');
    }
    if (!input.idempotencyKey) {
      throw new BadRequestException('idempotencyKey is required');
    }

    let debits = 0n;
    let credits = 0n;
    for (const entry of input.entries) {
      if (entry.amountMinor <= 0n) {
        throw new BadRequestException(
          `Entry amounts must be positive; direction carries the sign (got ${entry.amountMinor})`,
        );
      }
      if (entry.direction === EntryDirection.DEBIT) debits += entry.amountMinor;
      else credits += entry.amountMinor;
    }

    // The invariant. Everything else in this file exists to protect it.
    if (debits !== credits) {
      throw new BadRequestException(
        `Transaction does not balance: debits ${debits} ≠ credits ${credits}`,
      );
    }
  }

  /**
   * An idempotency key replayed with a *different* payload is a client bug.
   * Returning the original silently would hide it, so this 409s instead.
   */
  private assertReplayMatches(
    existing: Prisma.LedgerTransactionGetPayload<{ include: { entries: true } }>,
    input: PostInput,
  ): void {
    const existingTotal = existing.entries
      .filter((e) => e.direction === EntryDirection.DEBIT)
      .reduce((sum, e) => sum + e.amountMinor, 0n);
    const incomingTotal = input.entries
      .filter((e) => e.direction === EntryDirection.DEBIT)
      .reduce((sum, e) => sum + e.amountMinor, 0n);

    const same =
      existing.kind === input.kind &&
      existing.referenceType === input.referenceType &&
      existing.referenceId === input.referenceId &&
      existingTotal === incomingTotal;

    if (!same) {
      throw new ConflictException(
        `Idempotency-Key ${input.idempotencyKey} was already used for a different transaction`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────
  // Accounts
  // ─────────────────────────────────────────────────────────

  async createAccount(kind: AccountKind, ownerId?: string): Promise<string> {
    const account = await this.prisma.account.create({
      data: { kind, ownerId: ownerId ?? null },
    });
    return account.id;
  }

  /** The singleton platform accounts (RALIA_REVENUE, BANK_CLEARING). */
  async getPlatformAccountId(kind: AccountKind): Promise<string> {
    const account = await this.prisma.account.findFirst({ where: { kind, ownerId: null } });
    if (!account) {
      throw new NotFoundException(`Platform account ${kind} does not exist — is the seed run?`);
    }
    return account.id;
  }

  // ─────────────────────────────────────────────────────────
  // Commands — the money flows of handoff §5.6.
  // Callers pass account ids and amounts; this module touches nothing else.
  // ─────────────────────────────────────────────────────────

  /** Admin records a client's bank transfer. DR BANK_CLEARING / CR CAMPAIGN_ESCROW. */
  async fundCampaign(args: {
    campaignId: string;
    escrowAccountId: string;
    amountMinor: bigint;
    idempotencyKey: string;
    actorId?: string;
  }): Promise<{ transactionId: string; replayed: boolean }> {
    const bankClearing = await this.getPlatformAccountId(AccountKind.BANK_CLEARING);
    return this.post({
      kind: LedgerTransactionKind.CAMPAIGN_FUNDING,
      referenceType: 'campaign',
      referenceId: args.campaignId,
      idempotencyKey: args.idempotencyKey,
      memo: `Funding for campaign ${args.campaignId}`,
      createdBy: args.actorId,
      entries: [
        { accountId: bankClearing, direction: EntryDirection.DEBIT, amountMinor: args.amountMinor },
        { accountId: args.escrowAccountId, direction: EntryDirection.CREDIT, amountMinor: args.amountMinor },
      ],
    });
  }

  /**
   * Admin approves a submission: the promoter's fee and Ralia's take leave escrow
   * together, in ONE transaction — §5.6 is explicit about that.
   */
  async payoutSubmission(args: {
    submissionId: string;
    escrowAccountId: string;
    promoterAccountId: string;
    feeMinor: bigint;
    takeMinor: bigint;
    idempotencyKey: string;
    actorId?: string;
  }): Promise<{ transactionId: string; replayed: boolean }> {
    const revenue = await this.getPlatformAccountId(AccountKind.RALIA_REVENUE);
    const total = args.feeMinor + args.takeMinor;

    return this.post({
      kind: LedgerTransactionKind.SUBMISSION_PAYOUT,
      referenceType: 'submission',
      referenceId: args.submissionId,
      idempotencyKey: args.idempotencyKey,
      memo: `Payout for submission ${args.submissionId}`,
      createdBy: args.actorId,
      entries: [
        { accountId: args.escrowAccountId, direction: EntryDirection.DEBIT, amountMinor: total },
        { accountId: args.promoterAccountId, direction: EntryDirection.CREDIT, amountMinor: args.feeMinor },
        { accountId: revenue, direction: EntryDirection.CREDIT, amountMinor: args.takeMinor },
      ],
    });
  }

  /** Admin records that they sent the promoter's bank transfer. DR PROMOTER_AVAILABLE / CR BANK_CLEARING. */
  async payWithdrawal(args: {
    withdrawalId: string;
    promoterAccountId: string;
    amountMinor: bigint;
    idempotencyKey: string;
    actorId?: string;
  }): Promise<{ transactionId: string; replayed: boolean }> {
    const bankClearing = await this.getPlatformAccountId(AccountKind.BANK_CLEARING);
    return this.post({
      kind: LedgerTransactionKind.WITHDRAWAL_PAID,
      referenceType: 'withdrawal',
      referenceId: args.withdrawalId,
      idempotencyKey: args.idempotencyKey,
      memo: `Withdrawal ${args.withdrawalId} paid`,
      createdBy: args.actorId,
      entries: [
        { accountId: args.promoterAccountId, direction: EntryDirection.DEBIT, amountMinor: args.amountMinor },
        { accountId: bankClearing, direction: EntryDirection.CREDIT, amountMinor: args.amountMinor },
      ],
    });
  }

  /** Campaign ends with unspent escrow. DR CAMPAIGN_ESCROW / CR CLIENT_WALLET. */
  async refundCampaign(args: {
    campaignId: string;
    escrowAccountId: string;
    clientWalletAccountId: string;
    amountMinor: bigint;
    idempotencyKey: string;
    actorId?: string;
  }): Promise<{ transactionId: string; replayed: boolean }> {
    return this.post({
      kind: LedgerTransactionKind.CAMPAIGN_REFUND,
      referenceType: 'campaign',
      referenceId: args.campaignId,
      idempotencyKey: args.idempotencyKey,
      memo: `Unspent escrow returned for campaign ${args.campaignId}`,
      createdBy: args.actorId,
      entries: [
        { accountId: args.escrowAccountId, direction: EntryDirection.DEBIT, amountMinor: args.amountMinor },
        { accountId: args.clientWalletAccountId, direction: EntryDirection.CREDIT, amountMinor: args.amountMinor },
      ],
    });
  }
}
