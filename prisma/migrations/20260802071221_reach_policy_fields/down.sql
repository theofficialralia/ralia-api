-- AlterTable
ALTER TABLE "channels" DROP COLUMN "verified_at";

-- AlterTable
ALTER TABLE "rate_config" DROP COLUMN "proof_validity_days",
DROP COLUMN "unverified_reach_cap";

