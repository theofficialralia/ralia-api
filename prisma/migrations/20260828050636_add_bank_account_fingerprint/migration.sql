-- AlterTable
ALTER TABLE "promoter_bank_accounts" ADD COLUMN     "account_fingerprint" TEXT;

-- CreateIndex
CREATE INDEX "promoter_bank_accounts_account_fingerprint_idx" ON "promoter_bank_accounts"("account_fingerprint");
