import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  AssignmentStatus,
  CampaignObjective,
  CampaignStatus,
  ChannelStatus,
  OfferStatus,
  Platform,
  PromoterRole,
  PromoterStatus,
  PrismaClient,
  Role,
  SlotStatus,
  VerificationTier,
} from '@prisma/client';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateConfigModule } from '../../common/rate-config/rate-config.module';
import { computeEffectiveReach } from '../../common/reach/effective-reach';
import { MatchingModule } from '../matching/matching.module';
import { MatchingService } from '../matching/matching.service';
import { AllocationModule } from './allocation.module';
import { AllocationService } from './allocation.service';
import { testPrisma } from '../../../test/test-db';

describe('AllocationService — sweeps (§8)', () => {
  let prisma: PrismaClient;
  let matching: MatchingService;
  let allocation: AllocationService;
  let seq = 0;

  beforeAll(async () => {
    prisma = testPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RateConfigModule, MatchingModule, AllocationModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    matching = moduleRef.get(MatchingService);
    allocation = moduleRef.get(AllocationService);
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE users, user_roles, promoter_profiles, channels, client_orgs, campaigns, campaign_targeting, campaign_slots, offers, assignments, tracking_links, rate_config RESTART IDENTITY CASCADE',
    );
    await prisma.rateConfig.create({ data: { isActive: true } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeLiveCampaign(slots: number): Promise<string> {
    const owner = await prisma.user.create({
      data: { email: `c${seq++}@a.co`, phoneE164: `+23491${String(seq).padStart(8, '0')}`, passwordHash: 'x', status: 'ACTIVE', roles: { create: { role: Role.CLIENT } } },
    });
    const org = await prisma.clientOrg.create({ data: { ownerUserId: owner.id, name: `Org${seq}`, status: 'ACTIVE' } });
    const campaign = await prisma.campaign.create({
      data: {
        clientOrgId: org.id, name: `Camp${seq}`, objective: CampaignObjective.AWARENESS,
        destinationUrl: 'https://x.example/go', status: CampaignStatus.LIVE,
        budgetMinor: 34500n, priceMinor: 34500n, slotsTotal: slots, quotedAt: new Date(),
        targeting: { create: { states: [], lgas: [], genders: [], languages: [], categories: [], platforms: [], minEffectiveReach: 0, roles: [] } },
        slots: { create: Array.from({ length: slots }, () => ({ role: PromoterRole.DISTRIBUTOR, unitPriceMinor: 3450n, status: SlotStatus.OPEN })) },
      },
    });
    return campaign.id;
  }

  async function makePromoter(trust = 60): Promise<string> {
    const user = await prisma.user.create({
      data: { email: `p${seq++}@a.co`, phoneE164: `+23492${String(seq).padStart(8, '0')}`, passwordHash: 'x', status: 'ACTIVE', phoneVerifiedAt: new Date(), roles: { create: { role: Role.PROMOTER } } },
    });
    await prisma.promoterProfile.create({
      data: { userId: user.id, status: PromoterStatus.ACTIVE, age: 25, locationState: 'Lagos', languagesSpoken: ['English'], preferredCategories: ['Fashion'], trustScore: trust, maxCampaignsPerWeek: 3 },
    });
    await prisma.channel.create({
      data: { promoterId: user.id, platform: Platform.INSTAGRAM, claimedAudience: 20_000, verificationTier: VerificationTier.SCREENSHOT, effectiveReach: computeEffectiveReach(20_000, Platform.INSTAGRAM, VerificationTier.SCREENSHOT), status: ChannelStatus.ACTIVE },
    });
    return user.id;
  }

  /** Accept an offer, then backdate the delivery deadline (assignment + its posts) into the past. */
  async function acceptThenOverdue(campaignId: string, promoterId: string): Promise<string> {
    const [offer] = await matching.sendOffers(campaignId, [promoterId]);
    const assignment = await matching.accept(offer!.id, promoterId);
    const past = new Date(Date.now() - 60_000);
    await prisma.assignment.update({ where: { id: assignment.id }, data: { dueAt: past } });
    // §multi-day: reclaim keys off each scheduled post's deadline, so backdate those too.
    await prisma.deliverySlot.updateMany({ where: { assignmentId: assignment.id }, data: { dueAt: past } });
    return assignment.id;
  }

  it('reclaims an overdue IN_PROGRESS assignment: slot freed, slotsFilled decremented, no-show dinged', async () => {
    const campaignId = await makeLiveCampaign(1);
    const promoterId = await makePromoter(60);
    const assignmentId = await acceptThenOverdue(campaignId, promoterId);

    // Precondition: the accept filled the one slot.
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).slotsFilled).toBe(1);
    const slotId = (await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).slotId!;
    expect((await prisma.campaignSlot.findUniqueOrThrow({ where: { id: slotId } })).status).toBe(SlotStatus.FILLED);

    const reclaimed = await allocation.reclaimOverdueAssignments(new Date());
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe(AssignmentStatus.CANCELLED);
    expect((await prisma.campaignSlot.findUniqueOrThrow({ where: { id: slotId } })).status).toBe(SlotStatus.OPEN);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).slotsFilled).toBe(0);

    const profile = await prisma.promoterProfile.findUniqueOrThrow({ where: { userId: promoterId } });
    expect(profile.trustScore.toNumber()).toBe(50); // 60 − 10 (§4)
    expect(profile.reliability.toNumber()).toBeCloseTo(0, 3); // 1 CANCELLED, 0 PAID

    // The promoter is told why their reliability dropped.
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: promoterId, type: 'assignment.reclaimed' } });
    expect(note.body).toMatch(/expired/i);
  });

  it('spares a SUBMITTED post — proof is in the review queue, not a no-show', async () => {
    const campaignId = await makeLiveCampaign(1);
    const promoterId = await makePromoter(60);
    const assignmentId = await acceptThenOverdue(campaignId, promoterId);
    // §multi-day: a delivered post is SUBMITTED at the slot level — the sweep spares it.
    await prisma.deliverySlot.updateMany({ where: { assignmentId }, data: { status: 'SUBMITTED' } });
    await prisma.assignment.update({ where: { id: assignmentId }, data: { status: AssignmentStatus.SUBMITTED } });

    const reclaimed = await allocation.reclaimOverdueAssignments(new Date());

    // The SUBMITTED assignment is untouched; only its own row matters here.
    expect((await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } })).status).toBe(AssignmentStatus.SUBMITTED);
    expect((await prisma.promoterProfile.findUniqueOrThrow({ where: { userId: promoterId } })).trustScore.toNumber()).toBe(60);
    expect(reclaimed).toBe(0);
  });

  it('is idempotent — a second sweep neither re-reclaims nor double-dings', async () => {
    const campaignId = await makeLiveCampaign(1);
    const promoterId = await makePromoter(60);
    await acceptThenOverdue(campaignId, promoterId);

    await allocation.reclaimOverdueAssignments(new Date());
    const trustAfterFirst = (await prisma.promoterProfile.findUniqueOrThrow({ where: { userId: promoterId } })).trustScore.toNumber();
    const secondPass = await allocation.reclaimOverdueAssignments(new Date());

    expect(secondPass).toBe(0);
    expect((await prisma.promoterProfile.findUniqueOrThrow({ where: { userId: promoterId } })).trustScore.toNumber()).toBe(trustAfterFirst);
  });

  async function setApproved(campaignId: string, approvedAt: Date | null): Promise<void> {
    await prisma.campaign.update({ where: { id: campaignId }, data: { approvedAt } });
  }

  it('head-start phase gives the top fits an exclusive 1× shot (no over-offer)', async () => {
    const campaignId = await makeLiveCampaign(3);
    await setApproved(campaignId, new Date()); // just went live → inside head-start
    for (let i = 0; i < 4; i++) await makePromoter();

    const result = await allocation.allocateCampaign(campaignId, new Date());
    expect(result.phase).toBe('head-start');
    expect(result.sent).toBe(3); // one per open slot, not 1.5×
    expect(await prisma.offer.count({ where: { campaignId, status: OfferStatus.SENT } })).toBe(3);
  });

  it('open phase over-offers to ~1.5× the open slots', async () => {
    const campaignId = await makeLiveCampaign(2);
    await setApproved(campaignId, new Date(Date.now() - 48 * 60 * 60 * 1000)); // window long past → open
    for (let i = 0; i < 5; i++) await makePromoter();

    const result = await allocation.allocateCampaign(campaignId, new Date());
    expect(result.phase).toBe('open');
    expect(result.sent).toBe(3); // ceil(1.5 × 2)
  });

  it('is idempotent — a second pass with the target already met sends nothing', async () => {
    const campaignId = await makeLiveCampaign(2);
    await setApproved(campaignId, new Date(Date.now() - 48 * 60 * 60 * 1000));
    for (let i = 0; i < 6; i++) await makePromoter();

    const first = await allocation.allocateCampaign(campaignId, new Date());
    expect(first.sent).toBe(3);
    const second = await allocation.allocateCampaign(campaignId, new Date());
    expect(second.sent).toBe(0);
    expect(await prisma.offer.count({ where: { campaignId, status: OfferStatus.SENT } })).toBe(3);
  });

  it('reports "full" and sends nothing when every slot is filled', async () => {
    const campaignId = await makeLiveCampaign(1);
    const promoterId = await makePromoter();
    const [offer] = await matching.sendOffers(campaignId, [promoterId]);
    await matching.accept(offer!.id, promoterId); // fills the one slot

    const result = await allocation.allocateCampaign(campaignId, new Date());
    expect(result.phase).toBe('full');
    expect(result.sent).toBe(0);
  });

  it('allocateAll fills open slots across every LIVE campaign', async () => {
    const c1 = await makeLiveCampaign(2);
    const c2 = await makeLiveCampaign(1);
    await setApproved(c1, new Date(Date.now() - 48 * 60 * 60 * 1000)); // open phase
    await setApproved(c2, new Date(Date.now() - 48 * 60 * 60 * 1000));
    for (let i = 0; i < 6; i++) await makePromoter();

    const summary = await allocation.allocateAll(new Date());
    expect(summary.campaigns).toBe(2);
    // c1 open target ceil(1.5×2)=3, c2 target ceil(1.5×1)=2 → 5 offers, supply permitting.
    expect(summary.offersSent).toBe(5);
    expect(await prisma.offer.count({ where: { campaignId: c1, status: OfferStatus.SENT } })).toBe(3);
    expect(await prisma.offer.count({ where: { campaignId: c2, status: OfferStatus.SENT } })).toBe(2);
  });

  it('allocateAll ignores non-LIVE campaigns', async () => {
    const live = await makeLiveCampaign(1);
    const draft = await makeLiveCampaign(1);
    await prisma.campaign.update({ where: { id: draft }, data: { status: CampaignStatus.DRAFT } });
    await setApproved(live, new Date(Date.now() - 48 * 60 * 60 * 1000));
    for (let i = 0; i < 3; i++) await makePromoter();

    const summary = await allocation.allocateAll(new Date());
    expect(summary.campaigns).toBe(1); // only the LIVE one
    expect(await prisma.offer.count({ where: { campaignId: draft } })).toBe(0);
  });

  it('expires SENT offers past their window and leaves live ones alone', async () => {
    const campaignId = await makeLiveCampaign(5);
    const stalePromoter = await makePromoter();
    const freshPromoter = await makePromoter();
    const [stale] = await matching.sendOffers(campaignId, [stalePromoter]);
    const [fresh] = await matching.sendOffers(campaignId, [freshPromoter]);
    await prisma.offer.update({ where: { id: stale!.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });

    const expired = await allocation.expireStaleOffers(new Date());
    expect(expired).toBeGreaterThanOrEqual(1);

    expect((await prisma.offer.findUniqueOrThrow({ where: { id: stale!.id } })).status).toBe(OfferStatus.EXPIRED);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: fresh!.id } })).status).toBe(OfferStatus.SENT);
  });
});
