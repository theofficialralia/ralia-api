-- AlterTable
ALTER TABLE "promoter_profiles" DROP COLUMN "completed_deliveries",
DROP COLUMN "reliability";

-- AlterTable
ALTER TABLE "assignments" DROP COLUMN "delivered_on_time",
DROP COLUMN "paid_at";

