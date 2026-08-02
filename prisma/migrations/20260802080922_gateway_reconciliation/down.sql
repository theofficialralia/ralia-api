-- DropForeignKey
ALTER TABLE "gateway_payments" DROP CONSTRAINT "gateway_payments_campaign_id_fkey";

-- DropTable
DROP TABLE "gateway_payments";

-- DropEnum
DROP TYPE "PaymentProvider";

-- DropEnum
DROP TYPE "ReconciliationStatus";

