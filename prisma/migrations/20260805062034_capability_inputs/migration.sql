-- AlterTable
ALTER TABLE "promoter_profiles" ADD COLUMN     "capability_confirmed_at" TIMESTAMP(3),
ADD COLUMN     "capability_confirmed_by" UUID,
ADD COLUMN     "capability_inputs" JSONB,
ADD COLUMN     "capability_scores" JSONB,
ADD COLUMN     "roles" "PromoterRole"[];
