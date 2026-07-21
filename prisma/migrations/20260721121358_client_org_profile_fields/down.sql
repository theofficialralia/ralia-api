-- DropForeignKey
ALTER TABLE "client_orgs" DROP CONSTRAINT "client_orgs_logo_file_id_fkey";

-- AlterTable
ALTER TABLE "client_orgs" DROP COLUMN "address",
DROP COLUMN "cac_number",
DROP COLUMN "description",
DROP COLUMN "logo_file_id",
DROP COLUMN "support_contact_name",
DROP COLUMN "support_contact_phone",
DROP COLUMN "website";

