import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Campaign, CampaignStatus, Prisma, PromoterRole } from '@prisma/client';
import { buildEligibility } from '../../common/eligibility/eligibility';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateConfigService } from '../../common/rate-config/rate-config.service';
import {
  activeFilterCount,
  CampaignCategory,
  categoryForRole,
  slotPriceMinor,
  splitFee,
  TargetingFilters,
} from '../../common/pricing/pricing';
import { toMoney } from '../ledger/money';
import {
  CampaignDto,
  CampaignPlanDto,
  CreateCampaignDto,
  QuoteDto,
  RoleConfigDto,
  SetTargetingDto,
  UpdateCampaignDto,
} from './dto/campaign.dto';

/** Empty targeting — all filters inactive, multiplier 1.0. */
const NO_FILTERS: TargetingFilters = {
  states: [], lgas: [], ageMin: null, ageMax: null, genders: [],
  languages: [], categories: [], platforms: [], minEffectiveReach: 0, roles: [],
};

/** Statuses in which a campaign is still an editable draft. */
const EDITABLE: CampaignStatus[] = [CampaignStatus.DRAFT, CampaignStatus.QUOTED];

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateConfig: RateConfigService,
  ) {}

  // ── Ownership ────────────────────────────────────────────

  /** The caller's org, or 403 if they have none. */
  private async orgIdFor(userId: string): Promise<string> {
    const org = await this.prisma.clientOrg.findFirst({ where: { ownerUserId: userId } });
    if (!org) throw new ForbiddenException('This account has no client organisation.');
    return org.id;
  }

  private async ownedCampaign(userId: string, campaignId: string): Promise<Campaign> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    const orgId = await this.orgIdFor(userId);
    // 404 for someone else's campaign, not 403 — a 403 confirms the id exists.
    if (!campaign || campaign.clientOrgId !== orgId) throw new NotFoundException('No such campaign.');
    return campaign;
  }

  // ── Lifecycle ────────────────────────────────────────────

  async create(userId: string, dto: CreateCampaignDto): Promise<CampaignDto> {
    const orgId = await this.orgIdFor(userId);

    const campaign = await this.prisma.campaign.create({
      data: {
        clientOrgId: orgId,
        name: dto.name,
        objective: dto.objective,
        description: dto.description ?? null,
        promoterInstructions: dto.promoter_instructions ?? null,
        destinationUrl: dto.destination_url,
        status: CampaignStatus.DRAFT,
        // budget is only known once priced; 0 until a quote is accepted.
        budgetMinor: 0n,
        slotsTotal: dto.slots_total,
        targeting: { create: { states: [], lgas: [], genders: [], languages: [], categories: [], platforms: [], roles: [] } },
      },
    });

    return this.toDto(campaign);
  }

  async get(userId: string, campaignId: string): Promise<CampaignDto> {
    const campaign = await this.ownedCampaign(userId, campaignId);
    // Delivery proof for the client: human clicks driven across the campaign.
    const totalClicks = await this.prisma.clickEvent.count({
      where: { isBot: false, trackingLink: { assignment: { campaignId } } },
    });
    // Targeting is returned here so the client can resume a draft in the wizard.
    const t = await this.prisma.campaignTargeting.findUnique({ where: { campaignId } });
    const targeting = t
      ? {
          states: t.states, lgas: t.lgas, age_min: t.ageMin, age_max: t.ageMax,
          genders: t.genders, languages: t.languages, categories: t.categories,
          platforms: t.platforms, min_effective_reach: t.minEffectiveReach, roles: t.roles,
        }
      : null;
    return { ...this.toDto(campaign), total_clicks: totalClicks, targeting };
  }

  async list(userId: string): Promise<CampaignDto[]> {
    const orgId = await this.orgIdFor(userId);
    const campaigns = await this.prisma.campaign.findMany({
      where: { clientOrgId: orgId },
      orderBy: { createdAt: 'desc' },
    });
    return campaigns.map((c) => this.toDto(c));
  }

  async update(userId: string, campaignId: string, dto: UpdateCampaignDto): Promise<CampaignDto> {
    const campaign = await this.ownedCampaign(userId, campaignId);
    this.assertEditable(campaign);

    const data: Prisma.CampaignUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.objective !== undefined) data.objective = dto.objective;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.promoter_instructions !== undefined) data.promoterInstructions = dto.promoter_instructions;
    if (dto.destination_url !== undefined) data.destinationUrl = dto.destination_url;
    if (dto.slots_total !== undefined) data.slotsTotal = dto.slots_total;
    if (dto.role_config !== undefined) data.roleConfig = dto.role_config as unknown as Prisma.InputJsonValue;
    if (dto.needs_creative !== undefined) data.needsCreative = dto.needs_creative;
    if (dto.design_brief !== undefined) data.designBrief = dto.design_brief;

    // Any content change invalidates a prior quote — the price must be recomputed
    // before approval, so drop back to DRAFT and clear the stale price.
    if (campaign.status === CampaignStatus.QUOTED && Object.keys(data).length > 0) {
      data.status = CampaignStatus.DRAFT;
      data.priceMinor = null;
      data.quotedAt = null;
    }

    const updated = await this.prisma.campaign.update({ where: { id: campaignId }, data });
    return this.toDto(updated);
  }

  async setTargeting(userId: string, campaignId: string, dto: SetTargetingDto): Promise<CampaignDto> {
    const campaign = await this.ownedCampaign(userId, campaignId);
    this.assertEditable(campaign);

    if (dto.age_min !== undefined && dto.age_max !== undefined && dto.age_min > dto.age_max) {
      throw new BadRequestException('age_min cannot exceed age_max.');
    }

    await this.prisma.campaignTargeting.update({
      where: { campaignId },
      data: {
        states: dto.states ?? [],
        lgas: dto.lgas ?? [],
        ageMin: dto.age_min ?? null,
        ageMax: dto.age_max ?? null,
        genders: dto.genders ?? [],
        languages: dto.languages ?? [],
        categories: dto.categories ?? [],
        platforms: dto.platforms ?? [],
        minEffectiveReach: dto.min_effective_reach ?? 0,
        roles: dto.roles ?? [],
      },
    });

    // Targeting drives the price, so re-targeting invalidates a prior quote.
    if (campaign.status === CampaignStatus.QUOTED) {
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: { status: CampaignStatus.DRAFT, priceMinor: null, quotedAt: null },
      });
    }

    return this.toDto(await this.ownedCampaign(userId, campaignId));
  }

  // ── Quote ────────────────────────────────────────────────

  /**
   * Prices the campaign at current targeting and returns the estimate. Freezes
   * the price onto the campaign and moves it to QUOTED — a later rate_config
   * change never reprices it (§5.2).
   *
   * The per-slot reach basis is targeting.min_effective_reach: the client is
   * buying slots that each deliver at least that reach, which keeps the price a
   * deterministic function of what they specified rather than of the promoter
   * pool at the moment of quoting.
   */
  async quote(userId: string, campaignId: string): Promise<QuoteDto> {
    const campaign = await this.ownedCampaign(userId, campaignId);
    this.assertEditable(campaign);

    const targeting = await this.prisma.campaignTargeting.findUnique({ where: { campaignId } });
    const filters = targeting ? toFilters(targeting) : NO_FILTERS;

    const category = this.categoryOf(filters);
    const config = await this.rateConfig.getPricingConfig(category);
    // Reach per slot: the client's explicit floor if set, else the category default
    // (the create-campaign flow no longer asks for reach directly — it comes from
    // the chosen role's category).
    const defaults = await this.rateConfig.getCategoryDefaults(category);
    const reachPerSlot = filters.minEffectiveReach > 0 ? filters.minEffectiveReach : defaults.reachPerSlot;
    const unitPrice = slotPriceMinor(reachPerSlot, campaign.objective, filters, config);
    const totalPrice = unitPrice * BigInt(campaign.slotsTotal);

    // Category floor (governing logic #2): a campaign cannot be booked below its
    // category's minimum fee. Enforced here, at the commit point, not in plan().
    const floorMinor = await this.rateConfig.getCategoryFloorMinor(category);
    if (totalPrice < floorMinor) {
      throw new BadRequestException(
        `A ${categoryLabel(category)} campaign must be at least ${formatNaira(floorMinor)}. ` +
          `At ${campaign.slotsTotal} slot(s) × ${reachPerSlot} reach this prices to ` +
          `${formatNaira(totalPrice)} — raise the slot count or the reach per slot.`,
      );
    }

    const { promoterFeeMinor } = splitFee(unitPrice, config);

    const { count, reach } = await this.estimateEligible(filters);

    // Materialise the priced slots — the concurrency-safe units B5 reserves
    // against. Safe to delete and recreate here: a campaign is only quotable
    // while still editable, so no slot can yet be filled.
    const role = (filters.roles[0] as never) ?? 'DISTRIBUTOR';
    await this.prisma.$transaction([
      this.prisma.campaignSlot.deleteMany({ where: { campaignId } }),
      this.prisma.campaignSlot.createMany({
        data: Array.from({ length: campaign.slotsTotal }, () => ({
          campaignId,
          role,
          unitPriceMinor: unitPrice,
        })),
      }),
      this.prisma.campaign.update({
        where: { id: campaignId },
        data: {
          status: CampaignStatus.QUOTED,
          priceMinor: totalPrice,
          budgetMinor: totalPrice,
          quotedAt: new Date(),
        },
      }),
    ]);

    return {
      price: toMoney(totalPrice),
      unit_price: toMoney(unitPrice),
      promoter_fee: toMoney(promoterFeeMinor),
      slots_total: campaign.slotsTotal,
      estimated_reach: reach,
      eligible_promoters: count,
      active_filters: activeFilterCount(filters),
    };
  }

  /**
   * Stateless pricing preview for the budget↔reach slider — persists nothing. Given a
   * budget it solves how many slots that buys at current targeting (and thus the total
   * reach); given a slot count it prices that many directly. The client drags the
   * slider against this, then commits via update(slots_total) + quote().
   */
  async plan(
    userId: string,
    campaignId: string,
    driver: { budgetMinor?: number; slots?: number },
  ): Promise<CampaignPlanDto> {
    const campaign = await this.ownedCampaign(userId, campaignId);
    this.assertEditable(campaign);

    const targeting = await this.prisma.campaignTargeting.findUnique({ where: { campaignId } });
    const filters = targeting ? toFilters(targeting) : NO_FILTERS;

    const category = this.categoryOf(filters);
    const config = await this.rateConfig.getPricingConfig(category);
    const defaults = await this.rateConfig.getCategoryDefaults(category);
    // Reach per slot falls back to the category default when the client hasn't set one.
    const reachPerSlot = filters.minEffectiveReach > 0 ? filters.minEffectiveReach : defaults.reachPerSlot;
    const unitPrice = slotPriceMinor(reachPerSlot, campaign.objective, filters, config);

    // Budget wins if both are given: floor(budget / unit) slots. A budget below one
    // slot yields zero — the UI shows "raise your budget". Otherwise price the slots.
    let slots: number;
    if (driver.budgetMinor !== undefined) {
      slots = unitPrice > 0n ? Number(BigInt(driver.budgetMinor) / unitPrice) : 0;
    } else if (driver.slots !== undefined) {
      slots = driver.slots;
    } else {
      slots = campaign.slotsTotal;
    }
    slots = Math.min(Math.max(slots, 0), 10000);

    const totalPrice = unitPrice * BigInt(slots);
    const { promoterFeeMinor } = splitFee(unitPrice, config);

    // Floor for the slider (governing logic #2): the UI clamps the slider's minimum
    // to the category floor and pre-fills the category defaults. The preview itself
    // stays honest to the driver; quote() is the hard gate.
    const floorMinor = await this.rateConfig.getCategoryFloorMinor(category);
    const minSlots = unitPrice > 0n ? Number((floorMinor + unitPrice - 1n) / unitPrice) : 0; // ceil

    return {
      unit_price: toMoney(unitPrice),
      slots,
      total_price: toMoney(totalPrice),
      promoter_fee: toMoney(promoterFeeMinor),
      reach_per_slot: reachPerSlot,
      estimated_total_reach: slots * reachPerSlot,
      category,
      floor_minor: toMoney(floorMinor),
      min_slots: minSlots,
      meets_floor: totalPrice >= floorMinor,
      default_reach_per_slot: defaults.reachPerSlot,
      default_promoters: defaults.promoters,
    };
  }

  /** Submit a quoted campaign for admin approval. */
  async submitForApproval(userId: string, campaignId: string): Promise<CampaignDto> {
    const campaign = await this.ownedCampaign(userId, campaignId);
    if (campaign.status !== CampaignStatus.QUOTED) {
      throw new BadRequestException('Only a quoted campaign can be submitted for approval.');
    }
    const updated = await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: CampaignStatus.PENDING_APPROVAL },
    });
    return this.toDto(updated);
  }

  // ── Eligibility estimate (stage-1 of §5.3; the full ranked query is B5) ──

  private async estimateEligible(filters: TargetingFilters): Promise<{ count: number; reach: number }> {
    const config = await this.rateConfig.getActive();
    const { channelWhere, profileWhere } = buildEligibility(filters, config.minTrustScore);

    const eligible = await this.prisma.promoterProfile.findMany({
      where: profileWhere,
      select: { userId: true, user: { select: { channels: { where: channelWhere, select: { effectiveReach: true } } } } },
    });

    let reach = 0;
    for (const p of eligible) {
      // Best qualifying channel per promoter, not the sum — one promoter posts once.
      reach += Math.max(0, ...p.user.channels.map((c) => c.effectiveReach));
    }
    return { count: eligible.length, reach };
  }

  // ── Helpers ──────────────────────────────────────────────

  /** A campaign's pricing category, derived from the role it targets (default Distribution). */
  private categoryOf(filters: TargetingFilters): CampaignCategory {
    const role = (filters.roles[0] as PromoterRole) ?? PromoterRole.DISTRIBUTOR;
    return categoryForRole(role);
  }

  private assertEditable(campaign: Campaign): void {
    if (!EDITABLE.includes(campaign.status)) {
      throw new BadRequestException(`A ${campaign.status} campaign can no longer be edited.`);
    }
  }

  private toDto(campaign: Campaign): CampaignDto {
    return {
      id: campaign.id,
      name: campaign.name,
      objective: campaign.objective,
      status: campaign.status,
      description: campaign.description,
      promoter_instructions: campaign.promoterInstructions,
      destination_url: campaign.destinationUrl,
      slots_total: campaign.slotsTotal,
      slots_filled: campaign.slotsFilled,
      price: campaign.priceMinor === null ? null : toMoney(campaign.priceMinor),
      budget: toMoney(campaign.budgetMinor),
      quoted_at: campaign.quotedAt ? campaign.quotedAt.toISOString() : null,
      role_config: (campaign.roleConfig as unknown as RoleConfigDto | null) ?? null,
      needs_creative: campaign.needsCreative,
      design_brief: campaign.designBrief,
    };
  }
}

function categoryLabel(category: CampaignCategory): string {
  return category === 'CREATION' ? 'Creation/Participation' : 'Distribution';
}

/** Kobo → a human ₦ string for error messages, e.g. 1500000n → "₦15,000". */
function formatNaira(minor: bigint): string {
  return `₦${(minor / 100n).toLocaleString('en-NG')}`;
}

function toFilters(t: {
  states: string[]; lgas: string[]; ageMin: number | null; ageMax: number | null;
  genders: string[]; languages: string[]; categories: string[]; platforms: string[];
  minEffectiveReach: number; roles: string[];
}): TargetingFilters {
  return {
    states: t.states, lgas: t.lgas, ageMin: t.ageMin, ageMax: t.ageMax,
    genders: t.genders, languages: t.languages, categories: t.categories,
    platforms: t.platforms, minEffectiveReach: t.minEffectiveReach, roles: t.roles,
  };
}
