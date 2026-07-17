-- DropForeignKey
ALTER TABLE "offers" DROP CONSTRAINT "offers_slot_id_fkey";

-- DropForeignKey
ALTER TABLE "assignments" DROP CONSTRAINT "assignments_slot_id_fkey";

-- DropIndex
DROP INDEX "assignments_slot_id_key";

-- AlterTable
ALTER TABLE "offers" ALTER COLUMN "slot_id" SET NOT NULL;

-- AlterTable
ALTER TABLE "assignments" DROP COLUMN "slot_id";

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "campaign_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

