-- AlterTable
ALTER TABLE "rate_config" ADD COLUMN     "delivery_window_hours" INTEGER NOT NULL DEFAULT 48,
ADD COLUMN     "head_start_hours" INTEGER NOT NULL DEFAULT 12;
