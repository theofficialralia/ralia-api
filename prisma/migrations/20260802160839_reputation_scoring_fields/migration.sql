-- AlterTable
ALTER TABLE "assignments" ADD COLUMN     "delivered_on_time" BOOLEAN,
ADD COLUMN     "paid_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "promoter_profiles" ADD COLUMN     "completed_deliveries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reliability" DECIMAL(4,3) NOT NULL DEFAULT 0.5;
