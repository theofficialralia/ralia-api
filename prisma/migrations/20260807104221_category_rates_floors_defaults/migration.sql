-- AlterTable
ALTER TABLE "rate_config" ADD COLUMN     "default_promoters_creation" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "default_promoters_distribution" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "default_reach_creation" INTEGER NOT NULL DEFAULT 10000,
ADD COLUMN     "default_reach_distribution" INTEGER NOT NULL DEFAULT 1000,
ADD COLUMN     "floor_creation_minor" BIGINT NOT NULL DEFAULT 10000000,
ADD COLUMN     "floor_distribution_minor" BIGINT NOT NULL DEFAULT 1500000,
ADD COLUMN     "rpm_creation_minor" INTEGER NOT NULL DEFAULT 50000,
ADD COLUMN     "rpm_distribution_minor" INTEGER NOT NULL DEFAULT 300000;
