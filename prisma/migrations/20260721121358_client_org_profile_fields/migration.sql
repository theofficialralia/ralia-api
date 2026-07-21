-- AlterTable
ALTER TABLE "client_orgs" ADD COLUMN     "address" TEXT,
ADD COLUMN     "cac_number" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "logo_file_id" UUID,
ADD COLUMN     "support_contact_name" TEXT,
ADD COLUMN     "support_contact_phone" TEXT,
ADD COLUMN     "website" TEXT;

-- AddForeignKey
ALTER TABLE "client_orgs" ADD CONSTRAINT "client_orgs_logo_file_id_fkey" FOREIGN KEY ("logo_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

