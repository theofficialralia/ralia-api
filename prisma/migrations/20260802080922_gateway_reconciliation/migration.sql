-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('PAYSTACK');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('RECORDED', 'SETTLED', 'MISMATCH');

-- CreateTable
CREATE TABLE "gateway_payments" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'PAYSTACK',
    "reference" TEXT NOT NULL,
    "expected_minor" BIGINT NOT NULL,
    "gateway_minor" BIGINT NOT NULL,
    "ledger_transaction_id" UUID,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'RECORDED',
    "settlement_ref" TEXT,
    "settled_minor" BIGINT,
    "settled_by" UUID,
    "settled_at" TIMESTAMP(3),
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gateway_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gateway_payments_reference_key" ON "gateway_payments"("reference");

-- CreateIndex
CREATE INDEX "gateway_payments_status_idx" ON "gateway_payments"("status");

-- CreateIndex
CREATE INDEX "gateway_payments_campaign_id_idx" ON "gateway_payments"("campaign_id");

-- AddForeignKey
ALTER TABLE "gateway_payments" ADD CONSTRAINT "gateway_payments_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
