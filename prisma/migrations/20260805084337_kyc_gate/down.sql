-- AlterTable
ALTER TABLE "promoter_profiles" DROP COLUMN "kyc_status",
DROP COLUMN "kyc_verified_at",
DROP COLUMN "kyc_verified_by";

-- DropEnum
DROP TYPE "KycStatus";

