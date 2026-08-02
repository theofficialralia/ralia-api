-- AlterTable
ALTER TABLE "channels" ADD COLUMN     "verified_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "rate_config" ADD COLUMN     "proof_validity_days" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "unverified_reach_cap" INTEGER NOT NULL DEFAULT 2000;
