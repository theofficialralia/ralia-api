/**
 * Dev seed — handoff §8: 2 clients, ~40 promoters across all platforms,
 * 3 campaigns spanning every state.
 *
 * Deterministic: a fixed-seed PRNG, so a reseed reproduces the same data and
 * test expectations stay stable. Destructive — dev only, guarded below.
 */
import {
  AccountKind,
  AssetKind,
  CampaignObjective,
  CampaignStatus,
  ChannelStatus,
  ClientOrgStatus,
  ConsentPurpose,
  Gender,
  Platform,
  PrismaClient,
  PromoterRole,
  PromoterStatus,
  Role,
  SlotStatus,
  UserStatus,
  VerificationTier,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { FieldEncryptionService } from '../src/common/crypto/field-encryption.service';
import { computeEffectiveReach } from '../src/common/reach/effective-reach';

const prisma = new PrismaClient();
// Seeded bank details go through the same encryption as real ones, so the payout
// path reads seeded and live rows identically.
const crypto = new FieldEncryptionService();

const DEV_PASSWORD = 'Password123!';
const POLICY_VERSION = '2026-07-01';

// ── Deterministic PRNG (mulberry32) ──────────────────────────
let seedState = 0x9e3779b9;
function rand(): number {
  seedState |= 0;
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function pick<T>(arr: readonly T[]): T {
  const v = arr[Math.floor(rand() * arr.length)];
  if (v === undefined) throw new Error('pick() from empty array');
  return v;
}
function pickSome<T>(arr: readonly T[], min: number, max: number): T[] {
  const n = min + Math.floor(rand() * (max - min + 1));
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    out.push(...pool.splice(Math.floor(rand() * pool.length), 1));
  }
  return out;
}
function intBetween(min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

// ── Reference data ───────────────────────────────────────────
const STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue',
  'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'Gombe',
  'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara',
  'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau',
  'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara', 'FCT',
] as const;

const LANGUAGES = ['English', 'Pidgin', 'Hausa', 'Yoruba', 'Igbo', 'Fulfulde', 'Tiv', 'Efik'] as const;
// Canonical Category-of-Interest taxonomy (dev-support spec R736-GEN-OD-00001) —
// matches the client + promoter apps so categoryFit lines up.
const CATEGORIES = [
  'Technology & Digital Products',
  'Financial Services & Fintech',
  'Consumer Goods & Retail (FMCG)',
  'Lifestyle & Personal Care',
  'Health & Pharmaceuticals',
  'Entertainment, Media & Gaming',
  'Real Estate & Construction',
  'Travel',
  'Hospitality & Leisure',
  'Education & Career Services',
  'Mobility',
  'Logistics & Utilities',
  'Other / General',
] as const;
const PLATFORMS = Object.values(Platform);
const TIERS = Object.values(VerificationTier);
const GENDERS = Object.values(Gender);

const FIRST_NAMES = [
  'Chidi', 'Amaka', 'Tunde', 'Ngozi', 'Emeka', 'Fatima', 'Bola', 'Yusuf',
  'Ifeoma', 'Musa', 'Kemi', 'Obi', 'Halima', 'Segun', 'Zainab', 'Chioma',
  'Ibrahim', 'Funke', 'Nnamdi', 'Aisha',
] as const;
const LAST_NAMES = [
  'Okafor', 'Adeyemi', 'Bello', 'Eze', 'Ogunleye', 'Abubakar', 'Nwosu',
  'Balogun', 'Danjuma', 'Okonkwo',
] as const;

/** Claimed-audience ranges are platform-shaped so seeded reach looks plausible. */
const AUDIENCE_RANGE: Record<Platform, [number, number]> = {
  WHATSAPP_STATUS: [150, 1200],
  WHATSAPP_GROUP: [80, 900],
  INSTAGRAM: [500, 45000],
  X: [200, 30000],
  TIKTOK: [400, 60000],
  FACEBOOK: [300, 20000],
  TELEGRAM: [100, 8000],
  LINKEDIN: [200, 9000],
  OFFLINE: [50, 600],
};

async function wipe() {
  // FK-safe order: children first.
  await prisma.ledgerEntry.deleteMany();
  await prisma.ledgerTransaction.deleteMany();
  await prisma.withdrawal.deleteMany();
  await prisma.proofArtifact.deleteMany();
  await prisma.submission.deleteMany();
  await prisma.clickEvent.deleteMany();
  await prisma.trackingLink.deleteMany();
  await prisma.assignment.deleteMany();
  await prisma.offer.deleteMany();
  await prisma.campaignSlot.deleteMany();
  await prisma.campaignTargeting.deleteMany();
  await prisma.campaignAsset.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.channel.deleteMany();
  await prisma.promoterBankAccount.deleteMany();
  await prisma.promoterProfile.deleteMany();
  await prisma.clientOrg.deleteMany();
  await prisma.account.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.session.deleteMany();
  await prisma.consent.deleteMany();
  await prisma.otpCode.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.file.deleteMany();
  await prisma.user.deleteMany();
  await prisma.rateConfig.deleteMany();
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV=production. This script is destructive.');
  }

  console.log('→ wiping');
  await wipe();

  const passwordHash = await argon2.hash(DEV_PASSWORD);

  // ── rate_config: the single active row (§5.2) ──────────────
  console.log('→ rate_config');
  await prisma.rateConfig.create({ data: { isActive: true } });

  // ── Platform accounts (singletons) ─────────────────────────
  console.log('→ platform ledger accounts');
  await prisma.account.create({ data: { kind: AccountKind.RALIA_REVENUE } });
  await prisma.account.create({ data: { kind: AccountKind.BANK_CLEARING } });

  // ── Admin ──────────────────────────────────────────────────
  console.log('→ admin');
  const admin = await prisma.user.create({
    data: {
      email: 'admin@ralia.test',
      phoneE164: '+2348000000000',
      passwordHash,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
      roles: {
        create: {
          role: Role.ADMIN,
          // Both capabilities at launch, but held separately — handoff §7.
          capabilities: ['REVIEW_EVIDENCE', 'RECORD_MONEY'],
        },
      },
    },
  });

  // ── Clients ────────────────────────────────────────────────
  console.log('→ 2 clients');
  const clientOrgs = [];
  const clientSpecs = [
    { email: 'client1@ralia.test', phone: '+2348010000001', org: 'Naija Threads', industry: 'Consumer Goods & Retail (FMCG)' },
    { email: 'client2@ralia.test', phone: '+2348010000002', org: 'PayFlow NG', industry: 'Financial Services & Fintech' },
  ];
  for (const spec of clientSpecs) {
    const user = await prisma.user.create({
      data: {
        email: spec.email,
        phoneE164: spec.phone,
        passwordHash,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
        phoneVerifiedAt: new Date(),
        roles: { create: { role: Role.CLIENT } },
        consents: {
          create: [
            { purpose: ConsentPurpose.TERMS_OF_SERVICE, granted: true, grantedAt: new Date(), policyVersion: POLICY_VERSION },
            { purpose: ConsentPurpose.PRIVACY_POLICY, granted: true, grantedAt: new Date(), policyVersion: POLICY_VERSION },
          ],
        },
      },
    });
    const org = await prisma.clientOrg.create({
      data: {
        ownerUserId: user.id,
        name: spec.org,
        industry: spec.industry,
        phoneWhatsapp: spec.phone,
        status: ClientOrgStatus.ACTIVE,
      },
    });
    await prisma.account.create({ data: { kind: AccountKind.CLIENT_WALLET, ownerId: org.id } });
    clientOrgs.push(org);
  }

  // ── Promoters ──────────────────────────────────────────────
  console.log('→ 40 promoters across every platform');
  const promoterIds: string[] = [];
  for (let i = 0; i < 40; i++) {
    const firstName = pick(FIRST_NAMES);
    const lastName = pick(LAST_NAMES);
    const age = intBetween(18, 54);
    const dob = new Date(Date.UTC(2026 - age, intBetween(0, 11), intBetween(1, 28)));

    // Most promoters are ACTIVE so matching has a pool; a few sit in each
    // other state so the admin queues are not empty on a fresh seed.
    const status =
      i < 32 ? PromoterStatus.ACTIVE
      : i < 36 ? PromoterStatus.AWAITING_APPROVAL
      : i < 38 ? PromoterStatus.PROFILE_INCOMPLETE
      : PromoterStatus.REJECTED;

    const user = await prisma.user.create({
      data: {
        email: `promoter${i + 1}@ralia.test`,
        phoneE164: `+23481${String(10000000 + i).padStart(8, '0')}`,
        passwordHash,
        status: status === PromoterStatus.ACTIVE ? UserStatus.ACTIVE : UserStatus.PENDING,
        emailVerifiedAt: new Date(),
        phoneVerifiedAt: status === PromoterStatus.PROFILE_INCOMPLETE ? null : new Date(),
        roles: { create: { role: Role.PROMOTER } },
        consents: {
          create: [
            { purpose: ConsentPurpose.TERMS_OF_SERVICE, granted: true, grantedAt: new Date(), policyVersion: POLICY_VERSION },
            { purpose: ConsentPurpose.PRIVACY_POLICY, granted: true, grantedAt: new Date(), policyVersion: POLICY_VERSION },
            { purpose: ConsentPurpose.DATA_DOB, granted: true, grantedAt: new Date(), policyVersion: POLICY_VERSION },
            { purpose: ConsentPurpose.DATA_GENDER, granted: true, grantedAt: new Date(), policyVersion: POLICY_VERSION },
            // Deliberately not granted for some — exercises the revoked-consent
            // exclusion path in B2 harden.
            { purpose: ConsentPurpose.DATA_RELIGION, granted: i % 4 !== 0, grantedAt: i % 4 !== 0 ? new Date() : null, policyVersion: POLICY_VERSION },
          ],
        },
      },
    });

    await prisma.promoterProfile.create({
      data: {
        userId: user.id,
        status,
        fullName: `${firstName} ${lastName}`,
        dob,
        age,
        gender: pick(GENDERS),
        preferredLanguage: 'English',
        locationState: STATES[i % STATES.length]!,
        languagesSpoken: ['English', ...pickSome(LANGUAGES.filter((l) => l !== 'English'), 1, 2)],
        preferredCategories: pickSome(CATEGORIES, 2, 4),
        maxCampaignsPerWeek: intBetween(2, 6),
        trustScore: intBetween(28, 92),
        countriesTravelled: [],
        hobbies: [],
        skills: [],
        cameraComfortable: rand() > 0.4,
        approvedBy: status === PromoterStatus.ACTIVE ? admin.id : null,
        approvedAt: status === PromoterStatus.ACTIVE ? new Date() : null,
      },
    });

    // Every platform is represented: the first 9 promoters each anchor one.
    const platforms = i < PLATFORMS.length
      ? [PLATFORMS[i]!, ...pickSome(PLATFORMS, 0, 1)]
      : pickSome(PLATFORMS, 1, 3);

    for (const platform of [...new Set(platforms)]) {
      const [lo, hi] = AUDIENCE_RANGE[platform];
      const claimedAudience = intBetween(lo, hi);
      const tier = pick(TIERS);
      const isGroup = platform === Platform.WHATSAPP_GROUP;

      await prisma.channel.create({
        data: {
          promoterId: user.id,
          platform,
          handle: `@${firstName.toLowerCase()}${intBetween(10, 99)}`,
          url: platform === Platform.WHATSAPP_STATUS || platform === Platform.OFFLINE
            ? null
            : `https://example.test/${firstName.toLowerCase()}`,
          claimedAudience,
          isGroup,
          isGroupAdmin: isGroup ? rand() > 0.5 : false,
          groupMembers: isGroup ? claimedAudience : null,
          activeParticipants: isGroup ? Math.floor(claimedAudience * 0.3) : null,
          verificationTier: tier,
          effectiveReach: computeEffectiveReach(claimedAudience, platform, tier),
          status: status === PromoterStatus.ACTIVE ? ChannelStatus.ACTIVE : ChannelStatus.PENDING_REVIEW,
        },
      });
    }

    const accountNumber = String(intBetween(1000000000, 9999999999));
    await prisma.promoterBankAccount.create({
      data: {
        userId: user.id,
        bankCode: pick(['058', '044', '033', '011', '221']),
        accountNumberEnc: crypto.encrypt(accountNumber),
        accountNumberLast4: accountNumber.slice(-4),
        accountName: `${firstName} ${lastName}`.toUpperCase(),
        isDefault: true,
      },
    });

    promoterIds.push(user.id);
  }

  // ── Campaigns: targeting spans every state across the three ─
  console.log('→ 3 campaigns spanning every state');
  const third = Math.ceil(STATES.length / 3);
  const stateGroups = [
    STATES.slice(0, third),
    STATES.slice(third, third * 2),
    STATES.slice(third * 2),
  ];

  type CampaignSpec = {
    org: (typeof clientOrgs)[number];
    name: string;
    objective: CampaignObjective;
    categories: string[];
    platforms: Platform[];
    roles: PromoterRole[];
    status: CampaignStatus;
    slots: number;
    unitPriceMinor: bigint;
  };

  const campaignSpecs: CampaignSpec[] = [
    {
      org: clientOrgs[0]!,
      name: 'Naija Threads — Harmattan Drop',
      objective: CampaignObjective.AWARENESS,
      categories: ['Consumer Goods & Retail (FMCG)', 'Lifestyle & Personal Care'],
      platforms: [Platform.WHATSAPP_STATUS, Platform.INSTAGRAM, Platform.TIKTOK],
      roles: [PromoterRole.DISTRIBUTOR, PromoterRole.CREATOR],
      status: CampaignStatus.LIVE,
      slots: 12,
      unitPriceMinor: 45000n,
    },
    {
      org: clientOrgs[1]!,
      name: 'PayFlow — Merchant Signup Push',
      objective: CampaignObjective.LEAD_GEN,
      categories: ['Financial Services & Fintech', 'Technology & Digital Products'],
      platforms: [Platform.WHATSAPP_GROUP, Platform.X, Platform.LINKEDIN],
      roles: [PromoterRole.PARTICIPATOR, PromoterRole.INFLUENCER],
      status: CampaignStatus.PENDING_APPROVAL,
      slots: 8,
      unitPriceMinor: 90000n,
    },
    {
      org: clientOrgs[0]!,
      name: 'Naija Threads — Campus Ambassadors',
      objective: CampaignObjective.WEBSITE_VISIT,
      categories: ['Lifestyle & Personal Care', 'Entertainment, Media & Gaming'],
      platforms: [Platform.WHATSAPP_STATUS, Platform.FACEBOOK, Platform.TELEGRAM, Platform.OFFLINE],
      roles: [PromoterRole.DISTRIBUTOR],
      status: CampaignStatus.DRAFT,
      slots: 20,
      unitPriceMinor: 30000n,
    },
  ];

  for (let i = 0; i < campaignSpecs.length; i++) {
    const spec = campaignSpecs[i]!;
    const priceMinor = spec.unitPriceMinor * BigInt(spec.slots);
    const isPriced = spec.status !== CampaignStatus.DRAFT;

    const escrow = await prisma.account.create({
      data: { kind: AccountKind.CAMPAIGN_ESCROW },
    });

    const campaign = await prisma.campaign.create({
      data: {
        clientOrgId: spec.org.id,
        name: spec.name,
        objective: spec.objective,
        description: `Seed campaign for ${spec.org.name}.`,
        promoterInstructions: 'Post the supplied creative to your status and leave it up for 24 hours.',
        destinationUrl: 'https://example.test/landing',
        status: spec.status,
        needsCreative: spec.roles.includes(PromoterRole.CREATOR),
        budgetMinor: priceMinor,
        priceMinor: isPriced ? priceMinor : null,
        quotedAt: isPriced ? new Date() : null,
        escrowAccountId: escrow.id,
        slotsTotal: spec.slots,
        slotsFilled: 0,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        approvedBy: spec.status === CampaignStatus.LIVE ? admin.id : null,
        approvedAt: spec.status === CampaignStatus.LIVE ? new Date() : null,
        targeting: {
          create: {
            states: [...stateGroups[i]!],
            lgas: [],
            ageMin: 18,
            ageMax: 45,
            genders: [],
            languages: ['English'],
            categories: spec.categories,
            platforms: spec.platforms.map((p) => p.toString()),
            minEffectiveReach: 100,
            roles: spec.roles.map((r) => r.toString()),
          },
        },
        assets: {
          create: [
            { kind: AssetKind.CAPTION, captionText: `Shop ${spec.org.name} — link in my status.`, orderIndex: 0 },
          ],
        },
      },
    });

    await prisma.campaignSlot.createMany({
      data: Array.from({ length: spec.slots }, () => ({
        campaignId: campaign.id,
        role: spec.roles[0]!,
        unitPriceMinor: spec.unitPriceMinor,
        status: SlotStatus.OPEN,
      })),
    });
  }

  // ── Summary ────────────────────────────────────────────────
  const counts = {
    users: await prisma.user.count(),
    promoters: await prisma.promoterProfile.count(),
    activePromoters: await prisma.promoterProfile.count({ where: { status: PromoterStatus.ACTIVE } }),
    channels: await prisma.channel.count(),
    clientOrgs: await prisma.clientOrg.count(),
    campaigns: await prisma.campaign.count(),
    slots: await prisma.campaignSlot.count(),
    accounts: await prisma.account.count(),
  };
  const platformCoverage = await prisma.channel.groupBy({ by: ['platform'], _count: true });
  const statesCovered = new Set(
    (await prisma.campaignTargeting.findMany({ select: { states: true } })).flatMap((t) => t.states),
  );

  console.log('\n  Seed complete');
  console.table(counts);
  console.log(`  platforms with channels : ${platformCoverage.length}/${PLATFORMS.length}`);
  console.log(`  states covered by targeting : ${statesCovered.size}/${STATES.length}`);
  console.log(`\n  Dev login password for every seeded account: ${DEV_PASSWORD}`);
  console.log('  admin@ralia.test · client1@ralia.test · promoter1@ralia.test …promoter40\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
