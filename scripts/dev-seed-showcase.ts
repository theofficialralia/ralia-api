/**
 * Dev-only fixture: builds one richly-populated campaign for a client so the
 * evidence gallery and analytics screens have realistic data to render.
 *
 *   npx ts-node --transpile-only scripts/dev-seed-showcase.ts <client-email>
 *
 * Creates a LIVE campaign with a healthy budget, several promoters across
 * platforms, each with an approved+paid submission and a scatter of clicks, so
 * "spent of budget", views, acceptance and the gallery all look real.
 */
import {
  AccountKind, AssignmentStatus, CampaignObjective, CampaignStatus, ChannelStatus,
  EntryDirection, LedgerTransactionKind, OfferStatus, Platform, PromoterRole,
  PromoterStatus, PrismaClient, SlotStatus, Verdict, VerificationTier,
} from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

const UNIT = 3450n;
const FEE = 2415n;
const TAKE = 1035n;

const PROMOTERS = [
  { name: 'Adaeze Okafor', handle: '@adaeze', platform: Platform.WHATSAPP_STATUS, views: 812 },
  { name: 'Tunde Bello', handle: '@tundeb', platform: Platform.INSTAGRAM, views: 1420 },
  { name: 'Chiamaka Nwosu', handle: '@chiamaka', platform: Platform.WHATSAPP_STATUS, views: 3210 },
  { name: 'Yusuf Adeyemi', handle: '@yusuf', platform: Platform.INSTAGRAM, views: 604 },
  { name: 'Kelechi Made', handle: '@kelechi', platform: Platform.WHATSAPP_STATUS, views: 5480 },
  { name: 'Aisha Sani', handle: '@aisha', platform: Platform.INSTAGRAM, views: 940 },
  { name: 'Emeka James', handle: '@emekaj', platform: Platform.TIKTOK, views: 2110 },
  { name: 'Bola Tijani', handle: '@bolat', platform: Platform.WHATSAPP_STATUS, views: 760 },
  { name: 'Grace Umeh', handle: '@graceu', platform: Platform.TIKTOK, views: 1305 },
];

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run in production.');
  const email = process.argv[2];
  if (!email) throw new Error('Usage: dev-seed-showcase.ts <client-email>');

  const owner = await prisma.user.findUnique({ where: { email } });
  if (!owner) throw new Error(`No user ${email}`);
  const org = await prisma.clientOrg.findFirst({ where: { ownerUserId: owner.id } });
  if (!org) throw new Error(`${email} has no client org`);

  const slotsTotal = 12;
  const budget = UNIT * BigInt(slotsTotal);

  const bank = await account(AccountKind.BANK_CLEARING);
  const revenue = await account(AccountKind.RALIA_REVENUE);
  const escrow = await prisma.account.create({ data: { kind: AccountKind.CAMPAIGN_ESCROW } });

  const campaign = await prisma.campaign.create({
    data: {
      clientOrgId: org.id, name: 'Lagos launch — Skinsmith serum', objective: CampaignObjective.AWARENESS,
      description: 'Awareness push for the new serum across Lagos micro-influencers.',
      promoterInstructions: 'Post the supplied creative to your status/feed and leave it up 24h.',
      destinationUrl: 'https://skinsmith.example/serum', status: CampaignStatus.LIVE,
      budgetMinor: budget, priceMinor: budget, slotsTotal, slotsFilled: PROMOTERS.length,
      escrowAccountId: escrow.id, startsAt: new Date('2026-07-02'),
    },
  });

  await postTxn(LedgerTransactionKind.CAMPAIGN_FUNDING, campaign.id, [
    { accountId: bank, direction: EntryDirection.DEBIT, amountMinor: budget },
    { accountId: escrow.id, direction: EntryDirection.CREDIT, amountMinor: budget },
  ]);

  // A few extra offers that were declined/sent, so acceptance rate < 100%.
  let extraOffers = 0;

  for (const [i, p] of PROMOTERS.entries()) {
    const promoter = await prisma.user.create({
      data: {
        email: `showcase.${i}.${randomBytes(3).toString('hex')}@ralia.dev`,
        phoneE164: `+2349${String(100000000 + i).slice(0, 9)}${i}`, passwordHash: 'x', status: 'ACTIVE',
        roles: { create: { role: 'PROMOTER' } },
      },
    });
    await prisma.promoterProfile.create({ data: { userId: promoter.id, status: PromoterStatus.ACTIVE, fullName: p.name } });
    const channel = await prisma.channel.create({
      data: {
        promoterId: promoter.id, platform: p.platform, handle: p.handle, claimedAudience: p.views * 3,
        verificationTier: VerificationTier.SCREENSHOT, effectiveReach: p.views, status: ChannelStatus.ACTIVE,
      },
    });
    const slot = await prisma.campaignSlot.create({ data: { campaignId: campaign.id, role: PromoterRole.DISTRIBUTOR, unitPriceMinor: UNIT, status: SlotStatus.FILLED } });
    const offer = await prisma.offer.create({
      data: { campaignId: campaign.id, promoterId: promoter.id, channelId: channel.id, role: PromoterRole.DISTRIBUTOR, feeMinor: FEE, expiresAt: new Date(Date.now() + 1e7), status: OfferStatus.ACCEPTED },
    });
    const token = randomBytes(12).toString('base64url');
    const assignment = await prisma.assignment.create({
      data: {
        offerId: offer.id, campaignId: campaign.id, promoterId: promoter.id, channelId: channel.id, slotId: slot.id,
        role: PromoterRole.DISTRIBUTOR, feeMinor: FEE, trackingToken: token, status: AssignmentStatus.PAID,
      },
    });
    await prisma.trackingLink.create({ data: { token, assignmentId: assignment.id, destinationUrl: campaign.destinationUrl! } });

    const file = await prisma.file.create({ data: { storageKey: `showcase/${assignment.id}`, bucket: 'ralia-dev', mimeType: 'image/png', sizeBytes: 100, checksumSha256: randomUUID() } });
    const submission = await prisma.submission.create({ data: { assignmentId: assignment.id, verdict: Verdict.APPROVED, publicUrl: `https://instagram.com/p/${randomBytes(4).toString('hex')}` } });
    await prisma.proofArtifact.create({ data: { submissionId: submission.id, fileId: file.id, phash: randomBytes(8).toString('hex') } });

    // Views = clicks. Spread the submittedAt over the last few hours for "N hr ago".
    await prisma.submission.update({ where: { id: submission.id }, data: { submittedAt: new Date(Date.now() - i * 40 * 60 * 1000) } });
    const clicks = Array.from({ length: p.views }, (_, k) => ({ token, ipHash: `ip${i}-${k}`, uaHash: `ua${i}-${k}`, isBot: false }));
    // Insert clicks in chunks to keep the statement size sane.
    for (let c = 0; c < clicks.length; c += 500) await prisma.clickEvent.createMany({ data: clicks.slice(c, c + 500) });

    await postTxn(LedgerTransactionKind.SUBMISSION_PAYOUT, submission.id, [
      { accountId: escrow.id, direction: EntryDirection.DEBIT, amountMinor: UNIT },
      { accountId: promoter.id === '' ? '' : (await promoterAccount(promoter.id)), direction: EntryDirection.CREDIT, amountMinor: FEE },
      { accountId: revenue, direction: EntryDirection.CREDIT, amountMinor: TAKE },
    ]);

    // Every other promoter also declined an earlier offer somewhere → lower acceptance.
    if (i % 2 === 0) extraOffers++;
  }

  // Pad offers_sent with declines so acceptance rate looks realistic (~70%).
  for (let i = 0; i < extraOffers + 2; i++) {
    const p = await prisma.user.create({ data: { email: `decl.${i}.${randomBytes(3).toString('hex')}@ralia.dev`, phoneE164: `+2347${String(100000000 + i).slice(0, 9)}${i}`, passwordHash: 'x' } });
    const ch = await prisma.channel.create({ data: { promoterId: p.id, platform: Platform.X, claimedAudience: 100, effectiveReach: 5, status: ChannelStatus.ACTIVE } });
    await prisma.offer.create({ data: { campaignId: campaign.id, promoterId: p.id, channelId: ch.id, role: PromoterRole.DISTRIBUTOR, feeMinor: FEE, expiresAt: new Date(Date.now() + 1e7), status: OfferStatus.DECLINED } });
  }

  console.log(`\n  Showcase campaign ready:\n  id=${campaign.id}\n  owner=${email}\n  ${PROMOTERS.length} evidence items, ${slotsTotal} slots.\n`);
}

async function account(kind: AccountKind): Promise<string> {
  const found = await prisma.account.findFirst({ where: { kind, ownerId: null } });
  return (found ?? (await prisma.account.create({ data: { kind } }))).id;
}
async function promoterAccount(userId: string): Promise<string> {
  const found = await prisma.account.findFirst({ where: { kind: AccountKind.PROMOTER_AVAILABLE, ownerId: userId } });
  return (found ?? (await prisma.account.create({ data: { kind: AccountKind.PROMOTER_AVAILABLE, ownerId: userId } }))).id;
}
async function postTxn(kind: LedgerTransactionKind, refId: string, entries: { accountId: string; direction: EntryDirection; amountMinor: bigint }[]) {
  await prisma.ledgerTransaction.create({ data: { kind, referenceType: 'showcase', referenceId: refId, idempotencyKey: randomUUID(), entries: { create: entries } } });
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
