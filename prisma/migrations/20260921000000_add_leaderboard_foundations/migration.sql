-- CreateEnum
CREATE TYPE "PointEventType" AS ENUM ('DELIVERY_COMPLETED', 'DELIVERED_ON_TIME', 'OVER_DELIVERY', 'QUALITY_CLEAN', 'STREAK_BONUS', 'BREADTH_BONUS', 'MILESTONE', 'PENALTY_NO_SHOW', 'PENALTY_REJECTED', 'PENALTY_DUPLICATE', 'REVERSAL', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PromoterTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "min_tier" "PromoterTier";

-- AlterTable
ALTER TABLE "promoter_profiles" ADD COLUMN     "tier" "PromoterTier" NOT NULL DEFAULT 'BRONZE';

-- CreateTable
CREATE TABLE "point_events" (
    "id" UUID NOT NULL,
    "promoter_id" UUID NOT NULL,
    "type" "PointEventType" NOT NULL,
    "points" INTEGER NOT NULL,
    "submission_id" UUID,
    "assignment_id" UUID,
    "campaign_id" UUID,
    "dedupe_key" TEXT NOT NULL,
    "season_key" TEXT NOT NULL,
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "point_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promoter_scores" (
    "promoter_id" UUID NOT NULL,
    "lifetime_points" INTEGER NOT NULL DEFAULT 0,
    "season_key" TEXT NOT NULL,
    "season_points" INTEGER NOT NULL DEFAULT 0,
    "rolling_90_points" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "tier" "PromoterTier" NOT NULL DEFAULT 'BRONZE',
    "streak" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promoter_scores_pkey" PRIMARY KEY ("promoter_id")
);

-- CreateTable
CREATE TABLE "leaderboard_snapshots" (
    "id" UUID NOT NULL,
    "season_key" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'GLOBAL',
    "promoter_id" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboard_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboard_config" (
    "id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "pts_delivery_completed" INTEGER NOT NULL DEFAULT 50,
    "pts_on_time" INTEGER NOT NULL DEFAULT 20,
    "pts_quality_clean" INTEGER NOT NULL DEFAULT 15,
    "over_base" INTEGER NOT NULL DEFAULT 30,
    "over_cap_ratio" INTEGER NOT NULL DEFAULT 3,
    "streak_step" INTEGER NOT NULL DEFAULT 5,
    "streak_cap" INTEGER NOT NULL DEFAULT 50,
    "pts_breadth" INTEGER NOT NULL DEFAULT 10,
    "pts_milestone" INTEGER NOT NULL DEFAULT 25,
    "penalty_no_show" INTEGER NOT NULL DEFAULT 40,
    "penalty_rejected" INTEGER NOT NULL DEFAULT 20,
    "penalty_duplicate" INTEGER NOT NULL DEFAULT 30,
    "per_campaign_point_cap" INTEGER NOT NULL DEFAULT 150,
    "mult_creation_hundredths" INTEGER NOT NULL DEFAULT 150,
    "mult_distribution_hundredths" INTEGER NOT NULL DEFAULT 100,
    "season_length_days" INTEGER NOT NULL DEFAULT 30,
    "tier_silver_at" INTEGER NOT NULL DEFAULT 300,
    "tier_gold_at" INTEGER NOT NULL DEFAULT 800,
    "tier_platinum_at" INTEGER NOT NULL DEFAULT 2000,
    "tier_reliability_floor" DECIMAL(4,3) NOT NULL DEFAULT 0.80,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leaderboard_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "point_events_dedupe_key_key" ON "point_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "point_events_promoter_id_season_key_idx" ON "point_events"("promoter_id", "season_key");

-- CreateIndex
CREATE INDEX "point_events_season_key_type_idx" ON "point_events"("season_key", "type");

-- CreateIndex
CREATE INDEX "promoter_scores_season_key_season_points_idx" ON "promoter_scores"("season_key", "season_points");

-- CreateIndex
CREATE INDEX "promoter_scores_tier_idx" ON "promoter_scores"("tier");

-- CreateIndex
CREATE INDEX "leaderboard_snapshots_season_key_scope_rank_idx" ON "leaderboard_snapshots"("season_key", "scope", "rank");

-- AddForeignKey
ALTER TABLE "point_events" ADD CONSTRAINT "point_events_promoter_id_fkey" FOREIGN KEY ("promoter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promoter_scores" ADD CONSTRAINT "promoter_scores_promoter_id_fkey" FOREIGN KEY ("promoter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Seed the single active leaderboard_config row (all defaults). Mirrors rate_config.
INSERT INTO "leaderboard_config" ("id", "updated_at") VALUES (gen_random_uuid(), CURRENT_TIMESTAMP);
