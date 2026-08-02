-- AlterTable
ALTER TABLE "assignments" ADD COLUMN     "gross_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "promised_reach" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "offers" ADD COLUMN     "gross_minor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "promised_reach" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "rate_config" ADD COLUMN     "delivery_threshold_pct" INTEGER NOT NULL DEFAULT 70;

-- AlterTable
ALTER TABLE "submissions" ADD COLUMN     "claimed_views" INTEGER,
ADD COLUMN     "verified_reach" INTEGER;
