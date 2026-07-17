-- DropForeignKey
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_user_id_fkey";

-- DropForeignKey
ALTER TABLE "otp_codes" DROP CONSTRAINT "otp_codes_user_id_fkey";

-- DropForeignKey
ALTER TABLE "consents" DROP CONSTRAINT "consents_user_id_fkey";

-- DropForeignKey
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_user_id_fkey";

-- DropForeignKey
ALTER TABLE "client_orgs" DROP CONSTRAINT "client_orgs_owner_user_id_fkey";

-- DropForeignKey
ALTER TABLE "promoter_profiles" DROP CONSTRAINT "promoter_profiles_user_id_fkey";

-- DropForeignKey
ALTER TABLE "promoter_profiles" DROP CONSTRAINT "promoter_profiles_approved_by_fkey";

-- DropForeignKey
ALTER TABLE "promoter_bank_accounts" DROP CONSTRAINT "promoter_bank_accounts_user_id_fkey";

-- DropForeignKey
ALTER TABLE "channels" DROP CONSTRAINT "channels_promoter_id_fkey";

-- DropForeignKey
ALTER TABLE "channels" DROP CONSTRAINT "channels_evidence_file_id_fkey";

-- DropForeignKey
ALTER TABLE "files" DROP CONSTRAINT "files_uploaded_by_fkey";

-- DropForeignKey
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_client_org_id_fkey";

-- DropForeignKey
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_escrow_account_id_fkey";

-- DropForeignKey
ALTER TABLE "campaigns" DROP CONSTRAINT "campaigns_approved_by_fkey";

-- DropForeignKey
ALTER TABLE "campaign_assets" DROP CONSTRAINT "campaign_assets_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_assets" DROP CONSTRAINT "campaign_assets_file_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_targeting" DROP CONSTRAINT "campaign_targeting_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "campaign_slots" DROP CONSTRAINT "campaign_slots_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "offers" DROP CONSTRAINT "offers_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "offers" DROP CONSTRAINT "offers_promoter_id_fkey";

-- DropForeignKey
ALTER TABLE "offers" DROP CONSTRAINT "offers_channel_id_fkey";

-- DropForeignKey
ALTER TABLE "offers" DROP CONSTRAINT "offers_slot_id_fkey";

-- DropForeignKey
ALTER TABLE "assignments" DROP CONSTRAINT "assignments_offer_id_fkey";

-- DropForeignKey
ALTER TABLE "assignments" DROP CONSTRAINT "assignments_campaign_id_fkey";

-- DropForeignKey
ALTER TABLE "assignments" DROP CONSTRAINT "assignments_promoter_id_fkey";

-- DropForeignKey
ALTER TABLE "assignments" DROP CONSTRAINT "assignments_channel_id_fkey";

-- DropForeignKey
ALTER TABLE "tracking_links" DROP CONSTRAINT "tracking_links_assignment_id_fkey";

-- DropForeignKey
ALTER TABLE "click_events" DROP CONSTRAINT "click_events_token_fkey";

-- DropForeignKey
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_assignment_id_fkey";

-- DropForeignKey
ALTER TABLE "submissions" DROP CONSTRAINT "submissions_reviewed_by_fkey";

-- DropForeignKey
ALTER TABLE "proof_artifacts" DROP CONSTRAINT "proof_artifacts_submission_id_fkey";

-- DropForeignKey
ALTER TABLE "proof_artifacts" DROP CONSTRAINT "proof_artifacts_file_id_fkey";

-- DropForeignKey
ALTER TABLE "proof_artifacts" DROP CONSTRAINT "proof_artifacts_reuse_of_id_fkey";

-- DropForeignKey
ALTER TABLE "ledger_transactions" DROP CONSTRAINT "ledger_transactions_created_by_fkey";

-- DropForeignKey
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_transaction_id_fkey";

-- DropForeignKey
ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_account_id_fkey";

-- DropForeignKey
ALTER TABLE "withdrawals" DROP CONSTRAINT "withdrawals_promoter_id_fkey";

-- DropForeignKey
ALTER TABLE "withdrawals" DROP CONSTRAINT "withdrawals_bank_account_id_fkey";

-- DropForeignKey
ALTER TABLE "withdrawals" DROP CONSTRAINT "withdrawals_approved_by_fkey";

-- DropForeignKey
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_id_fkey";

-- DropTable
DROP TABLE "users";

-- DropTable
DROP TABLE "user_roles";

-- DropTable
DROP TABLE "otp_codes";

-- DropTable
DROP TABLE "consents";

-- DropTable
DROP TABLE "sessions";

-- DropTable
DROP TABLE "client_orgs";

-- DropTable
DROP TABLE "promoter_profiles";

-- DropTable
DROP TABLE "promoter_bank_accounts";

-- DropTable
DROP TABLE "channels";

-- DropTable
DROP TABLE "files";

-- DropTable
DROP TABLE "campaigns";

-- DropTable
DROP TABLE "campaign_assets";

-- DropTable
DROP TABLE "campaign_targeting";

-- DropTable
DROP TABLE "campaign_slots";

-- DropTable
DROP TABLE "offers";

-- DropTable
DROP TABLE "assignments";

-- DropTable
DROP TABLE "tracking_links";

-- DropTable
DROP TABLE "click_events";

-- DropTable
DROP TABLE "submissions";

-- DropTable
DROP TABLE "proof_artifacts";

-- DropTable
DROP TABLE "accounts";

-- DropTable
DROP TABLE "ledger_transactions";

-- DropTable
DROP TABLE "ledger_entries";

-- DropTable
DROP TABLE "withdrawals";

-- DropTable
DROP TABLE "audit_log";

-- DropTable
DROP TABLE "rate_config";

-- DropEnum
DROP TYPE "UserStatus";

-- DropEnum
DROP TYPE "Role";

-- DropEnum
DROP TYPE "AdminCapability";

-- DropEnum
DROP TYPE "OtpPurpose";

-- DropEnum
DROP TYPE "ConsentPurpose";

-- DropEnum
DROP TYPE "ClientOrgStatus";

-- DropEnum
DROP TYPE "PromoterStatus";

-- DropEnum
DROP TYPE "Gender";

-- DropEnum
DROP TYPE "Platform";

-- DropEnum
DROP TYPE "VerificationTier";

-- DropEnum
DROP TYPE "ChannelStatus";

-- DropEnum
DROP TYPE "CampaignObjective";

-- DropEnum
DROP TYPE "CampaignStatus";

-- DropEnum
DROP TYPE "AssetKind";

-- DropEnum
DROP TYPE "PromoterRole";

-- DropEnum
DROP TYPE "SlotStatus";

-- DropEnum
DROP TYPE "OfferStatus";

-- DropEnum
DROP TYPE "AssignmentStatus";

-- DropEnum
DROP TYPE "Verdict";

-- DropEnum
DROP TYPE "AccountKind";

-- DropEnum
DROP TYPE "EntryDirection";

-- DropEnum
DROP TYPE "LedgerTransactionKind";

-- DropEnum
DROP TYPE "WithdrawalStatus";

