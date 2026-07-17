-- DropForeignKey
ALTER TABLE "offers" DROP CONSTRAINT "offers_slot_id_fkey";

-- AlterTable
ALTER TABLE "assignments" ADD COLUMN     "slot_id" UUID;

-- AlterTable
ALTER TABLE "offers" ALTER COLUMN "slot_id" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "assignments_slot_id_key" ON "assignments"("slot_id");

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "campaign_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "campaign_slots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

