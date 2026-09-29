-- CreateEnum
CREATE TYPE "AdminInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

-- AlterEnum
ALTER TYPE "AdminCapability" ADD VALUE 'MANAGE_TEAM';

-- CreateTable
CREATE TABLE "admin_invites" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "capabilities" "AdminCapability"[],
    "token_hash" TEXT NOT NULL,
    "status" "AdminInviteStatus" NOT NULL DEFAULT 'PENDING',
    "invited_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_invites_email_idx" ON "admin_invites"("email");

-- CreateIndex
CREATE INDEX "admin_invites_status_idx" ON "admin_invites"("status");

-- AddForeignKey
ALTER TABLE "admin_invites" ADD CONSTRAINT "admin_invites_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
