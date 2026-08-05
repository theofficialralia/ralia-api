-- AlterEnum
BEGIN;
CREATE TYPE "LedgerTransactionKind_new" AS ENUM ('CAMPAIGN_FUNDING', 'SUBMISSION_PAYOUT', 'WITHDRAWAL_PAID', 'CAMPAIGN_REFUND', 'ADJUSTMENT');
ALTER TABLE "ledger_transactions" ALTER COLUMN "kind" TYPE "LedgerTransactionKind_new" USING ("kind"::text::"LedgerTransactionKind_new");
ALTER TYPE "LedgerTransactionKind" RENAME TO "LedgerTransactionKind_old";
ALTER TYPE "LedgerTransactionKind_new" RENAME TO "LedgerTransactionKind";
DROP TYPE "LedgerTransactionKind_old";
COMMIT;

