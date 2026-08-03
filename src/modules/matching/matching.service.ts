import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssignmentStatus,
  CampaignObjective,
  CampaignStatus,
  OfferStatus,
  Prisma,
  PromoterRole,
  SlotStatus,
  VerificationTier,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { buildEligibility } from '../../common/eligibility/eligibility';
import { slotPriceMinor, slotTargetReach, splitFee, PricingConfig, TargetingFilters } from '../../common/pricing/pricing';
import {
  DEFAULT_SCORING_CONFIG,
  PromoterRole as CapabilityRole,
  capabilityScore,
  capabilityTier,
  categoryFit,
  fatigueScore,
  isProven,
  matchScore,
  newbieGateActive,
  reachFit,
} from '../../common/scoring/scoring';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateConfigService } from '../../common/rate-config/rate-config.service';
import { toMoney } from '../ledger/money';
import { CandidateDto, OfferDto, AssignmentDto } from './dto/matching.dto';

@Injectable()
export class MatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateConfig: RateConfigService,
  ) {}

  // ── Candidates (admin) — §5.3 stage-1 hard filter ────────

  /**
   * Every promoter who passes the hard filter, ranked by the performance-weighted
   * match score (ALGORITHMS.md §7) and pruned by the supply-adaptive newbie gate.
   *
   * The DB where-clause (buildEligibility) is the hard filter — role/platform/geo/
   * age/language/status/trust≥floor. On top of it each survivor gets a match score
   * from capability, trust, reliability, right-sized reachFit, categoryFit and a
   * fatigue penalty, and the list is ordered by that score (the "Fit %" the admin and
   * promoter both see) rather than raw reach.
   */
  async candidates(campaignId: string): Promise<CandidateDto[]> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { targeting: true, slots: { where: { status: SlotStatus.OPEN }, take: 1 } },
    });
    if (!campaign) throw new NotFoundException('No such campaign.');

    const filters = toFilters(campaign.targeting);
    const rate = await this.rateConfig.getActive();
    const pricing = await this.rateConfig.getPricingConfig();
    const { channelWhere, profileWhere } = buildEligibility(filters, rate.minTrustScore);
    const ctx = this.scoringContext(campaign, filters, pricing);

    // Exclude anyone already offered this campaign (any status) — the unique
    // constraint permits only one offer per promoter per campaign, so these can't
    // be offered again and must not appear as selectable candidates.
    const engaged = await this.engagedPromoterIds(campaignId);

    const eligible = await this.prisma.promoterProfile.findMany({
      where: {
        ...profileWhere,
        ...(engaged.length > 0 ? { userId: { notIn: engaged } } : {}),
      },
      include: {
        user: {
          select: {
            id: true,
            channels: { where: channelWhere, orderBy: { effectiveReach: 'desc' } },
          },
        },
      },
    });

    // Weekly-cap check in code — it depends on a rolling window per promoter.
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const scored: (CandidateDto & { proven: boolean })[] = [];
    for (const p of eligible) {
      const bestChannel = p.user.channels[0];
      if (!bestChannel) continue; // safety; profileWhere already requires one

      const weekCount = await this.prisma.assignment.count({
        where: { promoterId: p.userId, createdAt: { gte: weekAgo } },
      });
      if (weekCount >= p.maxCampaignsPerWeek) continue;

      const fit = this.scoreCandidate(ctx, {
        effectiveReach: bestChannel.effectiveReach,
        verificationTier: bestChannel.verificationTier,
        trust: p.trustScore.toNumber(),
        reliability: p.reliability.toNumber(),
        weekCount,
        maxPerWeek: p.maxCampaignsPerWeek,
        promoterCategories: p.preferredCategories,
      });

      scored.push({
        promoter_id: p.userId,
        full_name: p.fullName,
        location_state: p.locationState,
        trust_score: p.trustScore.toNumber(),
        channel: {
          id: bestChannel.id,
          platform: bestChannel.platform,
          effective_reach: bestChannel.effectiveReach,
        },
        assignments_this_week: weekCount,
        max_campaigns_per_week: p.maxCampaignsPerWeek,
        match_score: fit.matchScore,
        fit_pct: Math.round(fit.matchScore * 100),
        capability: fit.capability,
        capability_tier: fit.tier,
        reliability: fit.reliability,
        proven: isProven(p.completedDeliveries, p.trustScore.toNumber(), ctx.config),
      });
    }

    // Supply-adaptive newbie gate (§7), decided per-campaign at match time: when
    // qualified supply is abundant relative to the open slots, drop unproven
    // promoters — but never below the point where proven supply can still fill.
    const slotsRemaining = Math.max(campaign.slotsTotal - campaign.slotsFilled, 0);
    let ranked = scored;
    if (newbieGateActive(scored.length, slotsRemaining, ctx.config)) {
      const proven = scored.filter((r) => r.proven);
      if (proven.length >= slotsRemaining) ranked = proven;
    }

    ranked.sort((a, b) => b.match_score - a.match_score);
    return ranked.map(({ proven: _proven, ...dto }) => dto);
  }

  // ── Scoring glue (ALGORITHMS.md §3/§7) ───────────────────

  /** Per-campaign scoring context: the slot's role + budgeted reach + targeted categories. */
  private scoringContext(
    campaign: { objective: CampaignObjective; slots: { role: PromoterRole; unitPriceMinor: bigint }[] },
    filters: TargetingFilters,
    pricing: PricingConfig,
  ) {
    const config = DEFAULT_SCORING_CONFIG;
    const slot = campaign.slots[0];
    const targetReach = slot ? slotTargetReach(slot.unitPriceMinor, campaign.objective, filters, pricing) : 0;
    const role: PromoterRole = slot?.role ?? 'DISTRIBUTOR';
    return { role, targetReach, campaignCategories: filters.categories, config };
  }

  private scoreCandidate(
    ctx: ReturnType<MatchingService['scoringContext']>,
    c: {
      effectiveReach: number;
      verificationTier: VerificationTier;
      trust: number;
      reliability: number;
      weekCount: number;
      maxPerWeek: number;
      promoterCategories: string[];
    },
  ) {
    // Capability from the signals we actually capture today: verified reach + proof
    // strength. Unmeasured factors default to neutral 0.5 so they neither inflate nor
    // tank the score; richer onboarding inputs (sample ratings, equipment) replace
    // them as they land. INFLUENCER shares the reach-driven distributor composition.
    const capRole = capabilityRoleFor(ctx.role);
    const reachFactor = clamp01(c.effectiveReach / ctx.config.capabilityReachReference);
    const proof = proofFactor(c.verificationTier);
    const capability = capabilityScore(capRole, provisionalFactors(capRole, reachFactor, proof));

    const rf = reachFit(c.effectiveReach, ctx.targetReach);
    const cf = categoryFit(c.promoterCategories, ctx.campaignCategories);
    const fatigue = fatigueScore(c.weekCount, c.maxPerWeek);
    const score = matchScore(
      { capability, trust: c.trust, reliability: c.reliability, reachFit: rf, categoryFit: cf, fatigue },
      ctx.config,
    );
    return { matchScore: score, capability, tier: capabilityTier(capability), reliability: c.reliability };
  }

  // ── Send offers (admin) ──────────────────────────────────

  async sendOffers(campaignId: string, promoterIds: string[]): Promise<OfferDto[]> {
    if (promoterIds.length === 0) throw new BadRequestException('No promoters selected.');

    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { targeting: true, slots: { take: 1 } },
    });
    if (!campaign) throw new NotFoundException('No such campaign.');
    if (campaign.status !== CampaignStatus.LIVE) {
      throw new BadRequestException('Offers can only be sent for a LIVE campaign.');
    }

    const slot = campaign.slots[0];
    if (!slot) throw new BadRequestException('This campaign has no slots.');

    const config = await this.rateConfig.getPricingConfig();
    const rate = await this.rateConfig.getActive();
    const filters = toFilters(campaign.targeting);
    const { channelWhere } = buildEligibility(filters, rate.minTrustScore);
    const ctx = this.scoringContext(campaign, filters, config);

    const expiresAt = new Date(Date.now() + rate.offerExpiryHours * 60 * 60 * 1000);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const role = slot.role;

    const created: OfferDto[] = [];
    for (const promoterId of [...new Set(promoterIds)]) {
      // A qualifying channel for this promoter.
      const channel = await this.prisma.channel.findFirst({
        where: { ...channelWhere, promoterId },
        orderBy: { effectiveReach: 'desc' },
      });
      if (!channel) {
        throw new BadRequestException(`Promoter ${promoterId} has no channel matching this campaign.`);
      }

      // Per-promoter pricing: the fee is priced from THIS promoter's effective
      // reach, and the gross + promised reach are frozen on the offer so
      // settlement can pro-rate against them (ALGORITHMS.md §2). Escrow can't be
      // overspent — the ledger's non-negative guard catches over-commitment at
      // payout — so no budget pre-check is enforced here (admin controls the pool).
      const grossMinor = slotPriceMinor(channel.effectiveReach, campaign.objective, filters, config);
      const { promoterFeeMinor } = splitFee(grossMinor, config);

      // Freeze the match score on the offer so the promoter sees the same "Fit %"
      // the ranking used, even as their signals drift afterwards (§7).
      const profile = await this.prisma.promoterProfile.findUnique({
        where: { userId: promoterId },
        select: { trustScore: true, reliability: true, preferredCategories: true, maxCampaignsPerWeek: true },
      });
      const weekCount = await this.prisma.assignment.count({
        where: { promoterId, createdAt: { gte: weekAgo } },
      });
      const fit = profile
        ? this.scoreCandidate(ctx, {
            effectiveReach: channel.effectiveReach,
            verificationTier: channel.verificationTier,
            trust: profile.trustScore.toNumber(),
            reliability: profile.reliability.toNumber(),
            weekCount,
            maxPerWeek: profile.maxCampaignsPerWeek,
            promoterCategories: profile.preferredCategories,
          })
        : null;

      try {
        const offer = await this.prisma.offer.create({
          data: {
            campaignId,
            promoterId,
            channelId: channel.id,
            role,
            feeMinor: promoterFeeMinor,
            grossMinor,
            promisedReach: channel.effectiveReach,
            score: fit ? fit.matchScore : null,
            expiresAt,
            status: OfferStatus.SENT,
          },
        });
        created.push(toOfferDto(offer, campaign.name));
      } catch (e) {
        // Unique (campaignId, promoterId): a promoter already offered this
        // campaign is skipped, not fatal to the batch.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }

    return created;
  }

  // ── Promoter: view / accept / decline ────────────────────

  async listOffers(promoterId: string): Promise<OfferDto[]> {
    const offers = await this.prisma.offer.findMany({
      where: { promoterId, status: OfferStatus.SENT, expiresAt: { gt: new Date() } },
      include: { campaign: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return offers.map((o) => toOfferDto(o, o.campaign.name));
  }

  /**
   * Accept an offer: reserve one open slot from the campaign's pool, atomically,
   * and create the assignment.
   *
   * Concurrency: the slot is taken with SELECT … FOR UPDATE SKIP LOCKED, so N
   * simultaneous accepts on an M-slot campaign reserve M distinct slots and the
   * rest find none — filling exactly M, never oversell. The offer row is locked
   * first so the same offer can't be accepted twice.
   */
  async accept(offerId: string, promoterId: string): Promise<AssignmentDto> {
    // Read the delivery window BEFORE opening the transaction: querying on this.prisma
    // inside an interactive tx borrows a second pooled connection, which deadlocks the
    // pool under concurrent accepts. The deadline itself is stamped inside the tx.
    const rate = await this.rateConfig.getActive();
    const deliveryWindowMs = rate.deliveryWindowHours * 60 * 60 * 1000;

    return this.prisma.$transaction(async (tx) => {
      // Lock the offer row; serialise concurrent accepts of the same offer.
      const locked = await tx.$queryRaw<{ id: string; status: OfferStatus; expires_at: Date; campaign_id: string; channel_id: string; role: string; fee_minor: bigint; gross_minor: bigint; promised_reach: number; promoter_id: string }[]>`
        SELECT id, status, expires_at, campaign_id, channel_id, role, fee_minor, gross_minor, promised_reach, promoter_id
        FROM offers WHERE id = ${offerId}::uuid FOR UPDATE`;
      const offer = locked[0];

      if (!offer || offer.promoter_id !== promoterId) throw new NotFoundException('No such offer.');
      if (offer.status !== OfferStatus.SENT) {
        throw new ConflictException(`This offer is ${offer.status.toLowerCase()} and cannot be accepted.`);
      }
      if (offer.expires_at < new Date()) {
        await tx.offer.update({ where: { id: offerId }, data: { status: OfferStatus.EXPIRED } });
        throw new ConflictException('This offer has expired.');
      }

      const campaign = await tx.campaign.findUnique({ where: { id: offer.campaign_id } });
      if (!campaign || campaign.status !== CampaignStatus.LIVE) {
        throw new ConflictException('This campaign is no longer accepting promoters.');
      }

      // Stamp the delivery deadline at accept (§8): miss it and the sweeper reclaims
      // the slot and dings the promoter. The window is a config knob (read above).
      const dueAt = new Date(Date.now() + deliveryWindowMs);

      // Reserve one open slot, skipping any a concurrent accept holds.
      const slots = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM campaign_slots
        WHERE campaign_id = ${offer.campaign_id}::uuid AND status = 'OPEN'
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`;
      const slot = slots[0];
      if (!slot) throw new ConflictException('This campaign is full.');

      await tx.campaignSlot.update({ where: { id: slot.id }, data: { status: SlotStatus.FILLED } });
      await tx.offer.update({ where: { id: offerId }, data: { status: OfferStatus.ACCEPTED } });

      const trackingToken = randomBytes(18).toString('base64url');

      const assignment = await tx.assignment.create({
        data: {
          offerId,
          campaignId: offer.campaign_id,
          promoterId,
          channelId: offer.channel_id,
          slotId: slot.id,
          role: offer.role as never,
          feeMinor: offer.fee_minor,
          grossMinor: offer.gross_minor,
          promisedReach: offer.promised_reach,
          trackingToken,
          status: AssignmentStatus.IN_PROGRESS,
          dueAt,
        },
      });

      // The tracking link exists because an assignment exists; B6 adds the
      // redirect endpoint and click ingestion over this row.
      await tx.trackingLink.create({
        data: { token: trackingToken, assignmentId: assignment.id, destinationUrl: campaign.destinationUrl ?? '' },
      });

      await tx.campaign.update({ where: { id: offer.campaign_id }, data: { slotsFilled: { increment: 1 } } });

      return toAssignmentDto(assignment);
    });
  }

  async decline(offerId: string, promoterId: string): Promise<void> {
    const offer = await this.prisma.offer.findUnique({ where: { id: offerId } });
    if (!offer || offer.promoterId !== promoterId) throw new NotFoundException('No such offer.');
    if (offer.status !== OfferStatus.SENT) {
      throw new ConflictException(`This offer is already ${offer.status.toLowerCase()}.`);
    }
    await this.prisma.offer.update({ where: { id: offerId }, data: { status: OfferStatus.DECLINED } });
  }

  // ── Promoter: my assignments (accepted work) ─────────────

  async myAssignments(promoterId: string) {
    const rows = await this.prisma.assignment.findMany({
      where: { promoterId },
      orderBy: { createdAt: 'desc' },
      include: {
        campaign: { select: { name: true, objective: true, promoterInstructions: true, destinationUrl: true } },
        submissions: { orderBy: { submittedAt: 'desc' }, take: 1, select: { verdict: true, rejectReason: true } },
      },
    });
    return rows.map((a) => ({
      id: a.id,
      campaign_id: a.campaignId,
      campaign_name: a.campaign.name,
      objective: a.campaign.objective,
      role: a.role,
      fee: toMoney(a.feeMinor),
      promised_reach: a.promisedReach,
      status: a.status,
      due_at: a.dueAt?.toISOString() ?? null,
      instructions: a.campaign.promoterInstructions,
      destination_url: a.campaign.destinationUrl,
      latest_verdict: a.submissions[0]?.verdict ?? null,
      reject_reason: a.submissions[0]?.rejectReason ?? null,
    }));
  }

  // ── Helpers ──────────────────────────────────────────────

  /**
   * Promoters who cannot be offered THIS campaign again. The @@unique(campaignId,
   * promoterId) constraint allows exactly one offer per promoter per campaign for its
   * lifetime, so anyone with an existing offer — of ANY status, including DECLINED and
   * EXPIRED — is out of the candidate pool. (Filtering only SENT/ACCEPTED here would let
   * candidates() surface promoters sendOffers() then silently P2002-skips.) Re-offering
   * an expired/declined promoter is a future feature that must reactivate the existing
   * offer row, not create a second one.
   */
  private async engagedPromoterIds(campaignId: string): Promise<string[]> {
    const rows = await this.prisma.offer.findMany({
      where: { campaignId },
      select: { promoterId: true },
    });
    return rows.map((r) => r.promoterId);
  }
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** INFLUENCER shares the reach-driven distributor composition; the rest map 1:1. */
function capabilityRoleFor(role: PromoterRole): CapabilityRole {
  return role === PromoterRole.INFLUENCER ? 'DISTRIBUTOR' : (role as CapabilityRole);
}

/** Proof strength of the promoter's best channel, normalised 0–1 (mirrors §1's verification spine). */
function proofFactor(tier: VerificationTier): number {
  return tier === VerificationTier.INSIGHTS ? 1 : tier === VerificationTier.SCREENSHOT ? 0.8 : 0.5;
}

/**
 * Provisional capability factors from measurable signals. Unmeasured factors sit at
 * neutral 0.5 until onboarding captures them, so capability is honest about what we
 * actually know rather than fabricated from thin data.
 */
function provisionalFactors(role: CapabilityRole, reachFactor: number, proof: number): Record<string, number> {
  const N = 0.5;
  if (role === 'DISTRIBUTOR') return { verifiedReach: reachFactor, postingFrequency: N, recentPostProof: proof };
  if (role === 'CREATOR') {
    return { ratedSamples: N, contentBreadth: N, equipment: N, cameraComfort: N, turnaround: N };
  }
  return { taskBreadth: N, deviceCoverage: N, multiStepWillingness: N, agedAccounts: N };
}

function toFilters(t: {
  states: string[]; lgas: string[]; ageMin: number | null; ageMax: number | null;
  genders: string[]; languages: string[]; categories: string[]; platforms: string[];
  minEffectiveReach: number; roles: string[];
} | null): TargetingFilters {
  if (!t) {
    return { states: [], lgas: [], ageMin: null, ageMax: null, genders: [], languages: [], categories: [], platforms: [], minEffectiveReach: 0, roles: [] };
  }
  return {
    states: t.states, lgas: t.lgas, ageMin: t.ageMin, ageMax: t.ageMax, genders: t.genders,
    languages: t.languages, categories: t.categories, platforms: t.platforms,
    minEffectiveReach: t.minEffectiveReach, roles: t.roles,
  };
}

function toOfferDto(
  o: {
    id: string; campaignId: string; role: string; feeMinor: bigint; expiresAt: Date; status: OfferStatus;
    score?: Prisma.Decimal | null;
  },
  campaignName: string,
): OfferDto {
  return {
    id: o.id,
    campaign_id: o.campaignId,
    campaign_name: campaignName,
    role: o.role,
    fee_minor: Number(o.feeMinor),
    expires_at: o.expiresAt.toISOString(),
    status: o.status,
    fit_pct: o.score != null ? Math.round(o.score.toNumber() * 100) : null,
  };
}

function toAssignmentDto(a: {
  id: string; campaignId: string; role: string; feeMinor: bigint; trackingToken: string; status: AssignmentStatus;
}): AssignmentDto {
  return {
    id: a.id,
    campaign_id: a.campaignId,
    role: a.role,
    fee_minor: Number(a.feeMinor),
    tracking_token: a.trackingToken,
    status: a.status,
  };
}
