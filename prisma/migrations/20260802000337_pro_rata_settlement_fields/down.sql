-- AlterTable
ALTER TABLE "offers" DROP COLUMN "gross_minor",
DROP COLUMN "promised_reach";

-- AlterTable
ALTER TABLE "assignments" DROP COLUMN "gross_minor",
DROP COLUMN "promised_reach";

-- AlterTable
ALTER TABLE "submissions" DROP COLUMN "claimed_views",
DROP COLUMN "verified_reach";

-- AlterTable
ALTER TABLE "rate_config" DROP COLUMN "delivery_threshold_pct";

