-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('NONE', 'PENDING', 'VERIFIED', 'REJECTED');

-- AlterTable
ALTER TABLE "promoter_profiles" ADD COLUMN     "kyc_status" "KycStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "kyc_verified_at" TIMESTAMP(3),
ADD COLUMN     "kyc_verified_by" UUID;
