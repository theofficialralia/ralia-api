-- CreateEnum
CREATE TYPE "Cadence" AS ENUM ('ONE_OFF', 'DAILY', 'WEEKLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "DeliverySlotStatus" AS ENUM ('PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED', 'MISSED');

-- AlterTable
ALTER TABLE "campaign_slots" ADD COLUMN     "posts_required" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "cadence" "Cadence" NOT NULL DEFAULT 'ONE_OFF',
ADD COLUMN     "posts_required" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "submissions" ADD COLUMN     "delivery_slot_id" UUID;

-- CreateTable
CREATE TABLE "delivery_slots" (
    "id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "status" "DeliverySlotStatus" NOT NULL DEFAULT 'PENDING',
    "gross_minor" BIGINT NOT NULL,
    "fee_minor" BIGINT NOT NULL,
    "promised_reach" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_slots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_slots_status_due_at_idx" ON "delivery_slots"("status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_slots_assignment_id_index_key" ON "delivery_slots"("assignment_id", "index");

-- CreateIndex
CREATE INDEX "submissions_delivery_slot_id_idx" ON "submissions"("delivery_slot_id");

-- AddForeignKey
ALTER TABLE "delivery_slots" ADD CONSTRAINT "delivery_slots_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_delivery_slot_id_fkey" FOREIGN KEY ("delivery_slot_id") REFERENCES "delivery_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
