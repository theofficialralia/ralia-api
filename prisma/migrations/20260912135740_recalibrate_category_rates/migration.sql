-- AlterTable
ALTER TABLE "rate_config" ALTER COLUMN "default_promoters_creation" SET DEFAULT 4,
ALTER COLUMN "default_promoters_distribution" SET DEFAULT 4,
ALTER COLUMN "default_reach_creation" SET DEFAULT 1000,
ALTER COLUMN "rpm_creation_minor" SET DEFAULT 2500000,
ALTER COLUMN "rpm_distribution_minor" SET DEFAULT 375000;

-- Recalibrate existing rate_config rows to the updated governing logic
-- (both categories: 1,000 reach/promoter, 4-promoter minimum; only price differs).
UPDATE "rate_config" SET
  "rpm_distribution_minor" = 375000,
  "rpm_creation_minor" = 2500000,
  "default_reach_creation" = 1000,
  "default_promoters_distribution" = 4,
  "default_promoters_creation" = 4;
