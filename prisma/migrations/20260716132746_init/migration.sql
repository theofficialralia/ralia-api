-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'BANNED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CLIENT', 'PROMOTER', 'ADMIN');

-- CreateEnum
CREATE TYPE "AdminCapability" AS ENUM ('REVIEW_EVIDENCE', 'RECORD_MONEY');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('PHONE_VERIFY', 'LOGIN', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('TERMS_OF_SERVICE', 'PRIVACY_POLICY', 'DATA_RELIGION', 'DATA_GENDER', 'DATA_DOB', 'MARKETING_EMAIL', 'MARKETING_WHATSAPP');

-- CreateEnum
CREATE TYPE "ClientOrgStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PromoterStatus" AS ENUM ('PROFILE_INCOMPLETE', 'AWAITING_APPROVAL', 'REJECTED', 'ACTIVE');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('WHATSAPP_STATUS', 'WHATSAPP_GROUP', 'INSTAGRAM', 'X', 'TIKTOK', 'FACEBOOK', 'TELEGRAM', 'LINKEDIN', 'OFFLINE');

-- CreateEnum
CREATE TYPE "VerificationTier" AS ENUM ('SELF', 'SCREENSHOT', 'INSIGHTS');

-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('PENDING_REVIEW', 'ACTIVE', 'REJECTED');

-- CreateEnum
CREATE TYPE "CampaignObjective" AS ENUM ('AWARENESS', 'APP_INSTALL', 'WEBSITE_VISIT', 'PURCHASE', 'LEAD_GEN');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'QUOTED', 'PENDING_APPROVAL', 'REJECTED', 'CONFIRMING_PAYMENT', 'LIVE', 'PAUSED', 'ENDED', 'FULFILLED', 'SETTLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('IMAGE', 'VIDEO', 'DOCUMENT', 'POSTER', 'CAPTION', 'LOGO');

-- CreateEnum
CREATE TYPE "PromoterRole" AS ENUM ('DISTRIBUTOR', 'CREATOR', 'PARTICIPATOR', 'INFLUENCER');

-- CreateEnum
CREATE TYPE "SlotStatus" AS ENUM ('OPEN', 'OFFERED', 'FILLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('CLIENT_WALLET', 'CAMPAIGN_ESCROW', 'PROMOTER_AVAILABLE', 'RALIA_REVENUE', 'BANK_CLEARING');

-- CreateEnum
CREATE TYPE "EntryDirection" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "LedgerTransactionKind" AS ENUM ('CAMPAIGN_FUNDING', 'SUBMISSION_PAYOUT', 'WITHDRAWAL_PAID', 'CAMPAIGN_REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('REQUESTED', 'APPROVED', 'PAID', 'FAILED', 'REVERSED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "email_verified_at" TIMESTAMP(3),
    "phone_verified_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "capabilities" "AdminCapability"[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "granted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "policy_version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_orgs" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT,
    "phone_whatsapp" TEXT,
    "status" "ClientOrgStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_orgs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promoter_profiles" (
    "user_id" UUID NOT NULL,
    "status" "PromoterStatus" NOT NULL DEFAULT 'PROFILE_INCOMPLETE',
    "dob" DATE,
    "age" INTEGER,
    "location_state" TEXT,
    "languages_spoken" TEXT[],
    "preferred_categories" TEXT[],
    "max_campaigns_per_week" INTEGER NOT NULL DEFAULT 3,
    "trust_score" DECIMAL(5,2) NOT NULL DEFAULT 50,
    "full_name" TEXT,
    "gender" "Gender",
    "preferred_language" TEXT,
    "education_level" TEXT,
    "qualifications" TEXT,
    "field_of_study" TEXT,
    "occupation" TEXT,
    "industry" TEXT,
    "employment_status" TEXT,
    "countries_travelled" TEXT[],
    "religion" TEXT,
    "location_lga" TEXT,
    "country_residence" TEXT,
    "country_birth" TEXT,
    "hobbies" TEXT[],
    "camera_comfortable" BOOLEAN,
    "skills" TEXT[],
    "device_info" JSONB,
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promoter_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "promoter_bank_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "bank_code" TEXT NOT NULL,
    "account_number_enc" TEXT NOT NULL,
    "account_number_last4" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promoter_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" UUID NOT NULL,
    "promoter_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "handle" TEXT,
    "url" TEXT,
    "claimed_audience" INTEGER NOT NULL,
    "is_group" BOOLEAN NOT NULL DEFAULT false,
    "is_group_admin" BOOLEAN NOT NULL DEFAULT false,
    "group_members" INTEGER,
    "active_participants" INTEGER,
    "verification_tier" "VerificationTier" NOT NULL DEFAULT 'SELF',
    "evidence_file_id" UUID,
    "effective_reach" INTEGER NOT NULL DEFAULT 0,
    "status" "ChannelStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "admin_frozen" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "checksum_sha256" TEXT NOT NULL,
    "uploaded_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "client_org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "objective" "CampaignObjective" NOT NULL,
    "description" TEXT,
    "promoter_instructions" TEXT,
    "destination_url" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "needs_creative" BOOLEAN NOT NULL DEFAULT false,
    "budget_minor" BIGINT NOT NULL,
    "price_minor" BIGINT,
    "quoted_at" TIMESTAMP(3),
    "escrow_account_id" UUID,
    "slots_total" INTEGER NOT NULL DEFAULT 0,
    "slots_filled" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "approved_by" UUID,
    "approved_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_assets" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "file_id" UUID,
    "caption_text" TEXT,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_targeting" (
    "campaign_id" UUID NOT NULL,
    "states" TEXT[],
    "lgas" TEXT[],
    "age_min" INTEGER,
    "age_max" INTEGER,
    "genders" TEXT[],
    "languages" TEXT[],
    "categories" TEXT[],
    "platforms" TEXT[],
    "min_effective_reach" INTEGER NOT NULL DEFAULT 0,
    "roles" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_targeting_pkey" PRIMARY KEY ("campaign_id")
);

-- CreateTable
CREATE TABLE "campaign_slots" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "role" "PromoterRole" NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "status" "SlotStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "promoter_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "slot_id" UUID NOT NULL,
    "role" "PromoterRole" NOT NULL,
    "score" DECIMAL(6,4),
    "fee_minor" BIGINT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'SENT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "promoter_id" UUID NOT NULL,
    "channel_id" UUID NOT NULL,
    "role" "PromoterRole" NOT NULL,
    "fee_minor" BIGINT NOT NULL,
    "tracking_token" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "due_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_links" (
    "token" TEXT NOT NULL,
    "assignment_id" UUID NOT NULL,
    "destination_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracking_links_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "click_events" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_hash" TEXT NOT NULL,
    "ua_hash" TEXT NOT NULL,
    "is_bot" BOOLEAN NOT NULL DEFAULT false,
    "referrer" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "click_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "public_url" TEXT,
    "note" TEXT,
    "auto_flag" BOOLEAN NOT NULL DEFAULT false,
    "verdict" "Verdict" NOT NULL DEFAULT 'PENDING',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMP(3),
    "reject_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proof_artifacts" (
    "id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "phash" TEXT NOT NULL,
    "reuse_of_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proof_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "owner_id" UUID,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL,
    "kind" "LedgerTransactionKind" NOT NULL,
    "reference_type" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "memo" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "direction" "EntryDirection" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" UUID NOT NULL,
    "promoter_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "approved_by" UUID,
    "paid_ref" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_config" (
    "id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "rpm_minor" INTEGER NOT NULL DEFAULT 3000,
    "mult_awareness" DECIMAL(4,2) NOT NULL DEFAULT 1.0,
    "mult_website_visit" DECIMAL(4,2) NOT NULL DEFAULT 1.1,
    "mult_app_install" DECIMAL(4,2) NOT NULL DEFAULT 1.25,
    "mult_lead_gen" DECIMAL(4,2) NOT NULL DEFAULT 1.4,
    "mult_purchase" DECIMAL(4,2) NOT NULL DEFAULT 1.5,
    "targeting_step" DECIMAL(4,2) NOT NULL DEFAULT 0.05,
    "targeting_cap" DECIMAL(4,2) NOT NULL DEFAULT 1.35,
    "take_rate" DECIMAL(4,2) NOT NULL DEFAULT 0.30,
    "factor_whatsapp_status" DECIMAL(4,2) NOT NULL DEFAULT 0.30,
    "factor_whatsapp_group" DECIMAL(4,2) NOT NULL DEFAULT 0.20,
    "factor_telegram" DECIMAL(4,2) NOT NULL DEFAULT 0.20,
    "factor_instagram" DECIMAL(4,2) NOT NULL DEFAULT 0.10,
    "factor_facebook" DECIMAL(4,2) NOT NULL DEFAULT 0.10,
    "factor_tiktok" DECIMAL(4,2) NOT NULL DEFAULT 0.12,
    "factor_x" DECIMAL(4,2) NOT NULL DEFAULT 0.05,
    "factor_linkedin" DECIMAL(4,2) NOT NULL DEFAULT 0.12,
    "factor_offline" DECIMAL(4,2) NOT NULL DEFAULT 0.15,
    "factor_tier_self" DECIMAL(4,2) NOT NULL DEFAULT 0.60,
    "factor_tier_screenshot" DECIMAL(4,2) NOT NULL DEFAULT 1.00,
    "factor_tier_insights" DECIMAL(4,2) NOT NULL DEFAULT 1.15,
    "offer_expiry_hours" INTEGER NOT NULL DEFAULT 24,
    "min_trust_score" INTEGER NOT NULL DEFAULT 30,
    "withdrawal_minimum_minor" BIGINT NOT NULL DEFAULT 500000,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_e164_key" ON "users"("phone_e164");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_id_role_key" ON "user_roles"("user_id", "role");

-- CreateIndex
CREATE INDEX "otp_codes_user_id_purpose_consumed_at_idx" ON "otp_codes"("user_id", "purpose", "consumed_at");

-- CreateIndex
CREATE INDEX "consents_user_id_purpose_idx" ON "consents"("user_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "client_orgs_owner_user_id_idx" ON "client_orgs"("owner_user_id");

-- CreateIndex
CREATE INDEX "promoter_profiles_status_trust_score_idx" ON "promoter_profiles"("status", "trust_score");

-- CreateIndex
CREATE INDEX "promoter_profiles_location_state_idx" ON "promoter_profiles"("location_state");

-- CreateIndex
CREATE INDEX "promoter_bank_accounts_user_id_idx" ON "promoter_bank_accounts"("user_id");

-- CreateIndex
CREATE INDEX "channels_promoter_id_idx" ON "channels"("promoter_id");

-- CreateIndex
CREATE INDEX "channels_platform_effective_reach_idx" ON "channels"("platform", "effective_reach");

-- CreateIndex
CREATE UNIQUE INDEX "files_storage_key_key" ON "files"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_escrow_account_id_key" ON "campaigns"("escrow_account_id");

-- CreateIndex
CREATE INDEX "campaigns_client_org_id_status_idx" ON "campaigns"("client_org_id", "status");

-- CreateIndex
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");

-- CreateIndex
CREATE INDEX "campaign_assets_campaign_id_order_index_idx" ON "campaign_assets"("campaign_id", "order_index");

-- CreateIndex
CREATE INDEX "campaign_slots_campaign_id_status_idx" ON "campaign_slots"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "offers_promoter_id_status_idx" ON "offers"("promoter_id", "status");

-- CreateIndex
CREATE INDEX "offers_status_expires_at_idx" ON "offers"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "offers_campaign_id_promoter_id_key" ON "offers"("campaign_id", "promoter_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_offer_id_key" ON "assignments"("offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_tracking_token_key" ON "assignments"("tracking_token");

-- CreateIndex
CREATE INDEX "assignments_promoter_id_status_idx" ON "assignments"("promoter_id", "status");

-- CreateIndex
CREATE INDEX "assignments_campaign_id_status_idx" ON "assignments"("campaign_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_links_assignment_id_key" ON "tracking_links"("assignment_id");

-- CreateIndex
CREATE INDEX "click_events_token_ts_idx" ON "click_events"("token", "ts");

-- CreateIndex
CREATE INDEX "click_events_token_is_bot_idx" ON "click_events"("token", "is_bot");

-- CreateIndex
CREATE INDEX "submissions_verdict_submitted_at_idx" ON "submissions"("verdict", "submitted_at");

-- CreateIndex
CREATE INDEX "submissions_assignment_id_idx" ON "submissions"("assignment_id");

-- CreateIndex
CREATE INDEX "proof_artifacts_phash_idx" ON "proof_artifacts"("phash");

-- CreateIndex
CREATE INDEX "proof_artifacts_submission_id_idx" ON "proof_artifacts"("submission_id");

-- CreateIndex
CREATE INDEX "accounts_kind_owner_id_idx" ON "accounts"("kind", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_idempotency_key_key" ON "ledger_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "ledger_transactions_reference_type_reference_id_idx" ON "ledger_transactions"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "ledger_transactions_kind_created_at_idx" ON "ledger_transactions"("kind", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_idx" ON "ledger_entries"("account_id");

-- CreateIndex
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries"("transaction_id");

-- CreateIndex
CREATE INDEX "withdrawals_promoter_id_status_idx" ON "withdrawals"("promoter_id", "status");

-- CreateIndex
CREATE INDEX "withdrawals_status_idx" ON "withdrawals"("status");

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_idx" ON "audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_created_at_idx" ON "audit_log"("actor_id", "created_at");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_orgs" ADD CONSTRAINT "client_orgs_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promoter_profiles" ADD CONSTRAINT "promoter_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promoter_profiles" ADD CONSTRAINT "promoter_profiles_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promoter_bank_accounts" ADD CONSTRAINT "promoter_bank_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_promoter_id_fkey" FOREIGN KEY ("promoter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_evidence_file_id_fkey" FOREIGN KEY ("evidence_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_client_org_id_fkey" FOREIGN KEY ("client_org_id") REFERENCES "client_orgs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_escrow_account_id_fkey" FOREIGN KEY ("escrow_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_assets" ADD CONSTRAINT "campaign_assets_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_targeting" ADD CONSTRAINT "campaign_targeting_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_slots" ADD CONSTRAINT "campaign_slots_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_promoter_id_fkey" FOREIGN KEY ("promoter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "campaign_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "offers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_promoter_id_fkey" FOREIGN KEY ("promoter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "click_events" ADD CONSTRAINT "click_events_token_fkey" FOREIGN KEY ("token") REFERENCES "tracking_links"("token") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proof_artifacts" ADD CONSTRAINT "proof_artifacts_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proof_artifacts" ADD CONSTRAINT "proof_artifacts_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proof_artifacts" ADD CONSTRAINT "proof_artifacts_reuse_of_id_fkey" FOREIGN KEY ("reuse_of_id") REFERENCES "proof_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_promoter_id_fkey" FOREIGN KEY ("promoter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "promoter_bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
