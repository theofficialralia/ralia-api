/**
 * Bootstrap the founding admin on a fresh environment (prod/staging).
 *
 * There is no self-signup for admins: the register/OTP flows only create CLIENT
 * and PROMOTER accounts, and every further admin is invited from inside the admin
 * app (MANAGE_TEAM). So the very first admin has to be inserted directly — that's
 * this script. Run it ONCE per environment; after that, invite the rest of the
 * team through the UI.
 *
 * Idempotent and non-destructive:
 *   - no user with that email  → creates an ACTIVE, email-verified admin with all
 *     capabilities (REVIEW_EVIDENCE, RECORD_MONEY, MANAGE_TEAM)
 *   - user exists but isn't an admin → adds the ADMIN role (keeps their password)
 *   - user is already an admin → does nothing
 *
 * Credentials come from the environment, never hardcoded:
 *   ADMIN_EMAIL=you@ralia.co ADMIN_PASSWORD='a-strong-password' npm run admin:create
 * Optional: ADMIN_PHONE=+2348012345678
 *
 * On Railway: run it as a one-off against the prod service so it uses the prod
 * DATABASE_URL, e.g.  railway run npm run admin:create
 */
import { AdminCapability, PrismaClient, Role, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const ALL_CAPABILITIES: AdminCapability[] = [
  AdminCapability.REVIEW_EVIDENCE,
  AdminCapability.RECORD_MONEY,
  AdminCapability.MANAGE_TEAM,
];

async function main(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const phone = process.env.ADMIN_PHONE?.trim() || null;

  if (!email || !password) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in the environment. Optional: ADMIN_PHONE.');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`ADMIN_EMAIL does not look like an email: ${email}`);
  }
  if (password.length < 10) {
    throw new Error('ADMIN_PASSWORD must be at least 10 characters.');
  }

  const existing = await prisma.user.findUnique({ where: { email }, include: { roles: true } });

  if (existing) {
    if (existing.roles.some((r) => r.role === Role.ADMIN)) {
      console.log(`✓ ${email} is already an admin — nothing to do.`);
      return;
    }
    await prisma.userRole.create({
      data: { userId: existing.id, role: Role.ADMIN, capabilities: ALL_CAPABILITIES },
    });
    console.log(`✓ Added the ADMIN role (all capabilities) to the existing account ${email}.`);
    return;
  }

  const passwordHash = await argon2.hash(password);
  await prisma.user.create({
    data: {
      email,
      phoneE164: phone,
      passwordHash,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: phone ? new Date() : null,
      roles: { create: { role: Role.ADMIN, capabilities: ALL_CAPABILITIES } },
    },
  });
  console.log(`✓ Created founding admin ${email} (ACTIVE, all capabilities). Sign in at the admin app and invite your team from there.`);
}

main()
  .catch((err) => {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
