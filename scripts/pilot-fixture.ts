/**
 * Dev-only fixture: gives the admin console something to review across the
 * money path — a funded live campaign with a submitted proof, a promoter with a
 * balance requesting a payout, and a recorded gateway charge to reconcile.
 *
 * Run against the seeded dev DB: npx ts-node --transpile-only scripts/pilot-fixture.ts
 */
import { AccountKind, AssignmentStatus, CampaignStatus, EntryDirection, LedgerTransactionKind, OfferStatus, PrismaClient, SlotStatus, Verdict, WithdrawalStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';

const prisma = new PrismaClient();

async function platformAccount(kind: AccountKind): Promise<string> {
  const a = await prisma.account.findFirstOrThrow({ where: { kind, ownerId: null } });
  return a.id;
}

async function main() {
  const campaign = await prisma.campaign.findFirstOrThrow({ where: { status: CampaignStatus.LIVE }, include: { slots: { where: { status: SlotStatus.OPEN }, take: 2 } } });

  // Fund escrow so a payout can settle.
  let escrowId = campaign.escrowAccountId;
  if (!escrowId) {
    const acc = await prisma.account.create({ data: { kind: AccountKind.CAMPAIGN_ESCROW, ownerId: campaign.id } });
    escrowId = acc.id;
    await prisma.campaign.update({ where: { id: campaign.id }, data: { escrowAccountId: escrowId } });
  }
  const bank = await platformAccount(AccountKind.BANK_CLEARING);
  const fundMinor = 20_000n;
  await prisma.ledgerTransaction.create({
    data: {
      kind: LedgerTransactionKind.CAMPAIGN_FUNDING, referenceType: 'campaign', referenceId: campaign.id,
      idempotencyKey: `fixture:fund:${campaign.id}`, memo: 'fixture funding',
      entries: { create: [{ accountId: bank, direction: EntryDirection.DEBIT, amountMinor: fundMinor }, { accountId: escrowId, direction: EntryDirection.CREDIT, amountMinor: fundMinor }] },
    },
  });

  // A promoter with a matching channel accepts and submits proof.
  const promoter = await prisma.promoterProfile.findFirstOrThrow({ where: { status: 'ACTIVE', user: { channels: { some: { status: 'ACTIVE' } } } }, include: { user: { include: { channels: { where: { status: 'ACTIVE' }, take: 1 } } } } });
  const channel = promoter.user.channels[0]!;
  const slot = campaign.slots[0]!;
  const promisedReach = channel.effectiveReach || 2000;
  const grossMinor = 6000n;
  const feeMinor = 4200n;

  const offer = await prisma.offer.create({
    data: { campaignId: campaign.id, promoterId: promoter.userId, channelId: channel.id, role: slot.role, feeMinor, grossMinor, promisedReach, expiresAt: new Date(Date.now() + 1e7), status: OfferStatus.ACCEPTED },
  });
  await prisma.campaignSlot.update({ where: { id: slot.id }, data: { status: SlotStatus.FILLED } });
  const assignment = await prisma.assignment.create({
    data: { offerId: offer.id, campaignId: campaign.id, promoterId: promoter.userId, channelId: channel.id, slotId: slot.id, role: slot.role, feeMinor, grossMinor, promisedReach, trackingToken: randomBytes(12).toString('base64url'), status: AssignmentStatus.SUBMITTED },
  });
  const file = await prisma.file.create({ data: { storageKey: `fixture/${assignment.id}.png`, bucket: 'ralia-dev', mimeType: 'image/png', sizeBytes: 1024, checksumSha256: 'x', uploadedBy: promoter.userId } });
  const submission = await prisma.submission.create({ data: { assignmentId: assignment.id, claimedViews: 1800, verdict: Verdict.PENDING, note: 'Posted at 9am, kept 24h.' } });
  await prisma.proofArtifact.create({ data: { submissionId: submission.id, fileId: file.id, phash: '0'.repeat(16) } });

  // A second promoter with a balance requests a payout.
  const payee = await prisma.promoterProfile.findFirstOrThrow({ where: { status: 'ACTIVE', userId: { not: promoter.userId }, user: { bankAccounts: { some: {} } } }, include: { user: { include: { bankAccounts: { take: 1 } } } } });
  const payeeAcc = await prisma.account.create({ data: { kind: AccountKind.PROMOTER_AVAILABLE, ownerId: payee.userId } });
  await prisma.ledgerTransaction.create({
    data: {
      kind: LedgerTransactionKind.ADJUSTMENT, referenceType: 'fixture', referenceId: payee.userId, idempotencyKey: `fixture:bal:${payee.userId}`, memo: 'fixture balance',
      entries: { create: [{ accountId: await platformAccount(AccountKind.RALIA_REVENUE), direction: EntryDirection.DEBIT, amountMinor: 8000n }, { accountId: payeeAcc.id, direction: EntryDirection.CREDIT, amountMinor: 8000n }] },
    },
  });
  await prisma.withdrawal.create({ data: { promoterId: payee.userId, amountMinor: 6000n, bankAccountId: payee.user.bankAccounts[0]!.id, status: WithdrawalStatus.REQUESTED } });

  // A recorded gateway charge to reconcile.
  await prisma.gatewayPayment.create({ data: { campaignId: campaign.id, reference: `PSTK-${randomBytes(3).toString('hex')}`, expectedMinor: 540000n, gatewayMinor: 540000n } });

  console.log(`✓ fixture ready — submission ${submission.id.slice(0, 8)}, withdrawal for ${payee.fullName}, 1 gateway charge`);
}

main().finally(() => prisma.$disconnect());
