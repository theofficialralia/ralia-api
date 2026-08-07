-- Governing logic: Ralia/promoter revenue split moves from 70/30 to 50/50.
-- AlterTable
ALTER TABLE "rate_config" ALTER COLUMN "take_rate" SET DEFAULT 0.50;

-- Flip any row still carrying the old 0.30 default. A campaign stores the price
-- it was quoted at, so this never reprices a live campaign (handoff §5.2); it only
-- changes the split applied to campaigns quoted from here on.
UPDATE "rate_config" SET "take_rate" = 0.50 WHERE "take_rate" = 0.30;
