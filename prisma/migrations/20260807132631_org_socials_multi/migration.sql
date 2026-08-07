/*
  Warnings:

  - You are about to drop the column `social_followers` on the `client_orgs` table. All the data in the column will be lost.
  - You are about to drop the column `social_platform` on the `client_orgs` table. All the data in the column will be lost.
  - You are about to drop the column `social_url` on the `client_orgs` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "client_orgs" DROP COLUMN "social_followers",
DROP COLUMN "social_platform",
DROP COLUMN "social_url",
ADD COLUMN     "socials" JSONB;
