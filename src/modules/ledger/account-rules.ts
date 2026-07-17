import { AccountKind, EntryDirection } from '@prisma/client';

/**
 * Which direction increases each account, and which accounts may never go
 * negative.
 *
 * The money flows in handoff §5.6 fix these:
 *   Fund campaign:  DR BANK_CLEARING    / CR CAMPAIGN_ESCROW
 *   Approve:        DR CAMPAIGN_ESCROW  / CR PROMOTER_AVAILABLE  (fee)
 *                   DR CAMPAIGN_ESCROW  / CR RALIA_REVENUE       (take)
 *   Withdrawal:     DR PROMOTER_AVAILABLE / CR BANK_CLEARING
 *   Refund:         DR CAMPAIGN_ESCROW  / CR CLIENT_WALLET
 *
 * So escrow, promoter and client balances rise on CREDIT — they are what Ralia
 * owes someone. BANK_CLEARING rises on DEBIT: it stands for cash actually held,
 * and it is the counterparty to every real-world bank transfer.
 */

export type AccountRule = {
  /** The direction that increases this account's balance. */
  normal: EntryDirection;
  /**
   * True where a negative balance would mean paying out money that was never
   * received. Enforced inside the posting transaction.
   */
  nonNegative: boolean;
};

export const ACCOUNT_RULES: Record<AccountKind, AccountRule> = {
  CLIENT_WALLET: { normal: EntryDirection.CREDIT, nonNegative: true },
  CAMPAIGN_ESCROW: { normal: EntryDirection.CREDIT, nonNegative: true },
  PROMOTER_AVAILABLE: { normal: EntryDirection.CREDIT, nonNegative: true },

  // Revenue only ever rises in normal operation, but a correcting reversal may
  // debit it. Not constrained.
  RALIA_REVENUE: { normal: EntryDirection.CREDIT, nonNegative: false },

  // Net cash position. Legitimately negative if Ralia fronts a payout before a
  // client's transfer clears, which is an operational fact, not a bug.
  BANK_CLEARING: { normal: EntryDirection.DEBIT, nonNegative: false },
};

/** Accounts whose balance must never fall below zero. */
export const NON_NEGATIVE_KINDS: AccountKind[] = (
  Object.keys(ACCOUNT_RULES) as AccountKind[]
).filter((kind) => ACCOUNT_RULES[kind].nonNegative);

/** Singleton platform accounts — exactly one row each, created by the seed. */
export const PLATFORM_ACCOUNT_KINDS: AccountKind[] = [
  AccountKind.RALIA_REVENUE,
  AccountKind.BANK_CLEARING,
];
