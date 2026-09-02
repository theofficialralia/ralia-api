import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AssignmentStatus, Campaign, LedgerTransactionKind, OfferStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { STORAGE, StorageProvider } from '../../common/storage/storage';
import { toMoney } from '../ledger/money';
import {
  CampaignAnalyticsDto,
  DashboardCampaignRowDto,
  DashboardSummaryDto,
  EvidenceItemDto,
} from './dto/analytics.dto';

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  // ── Ownership ────────────────────────────────────────────

  private async ownedCampaign(userId: string, campaignId: string): Promise<Campaign> {
    const org = await this.prisma.clientOrg.findFirst({ where: { ownerUserId: userId } });
    if (!org) throw new ForbiddenException('This account has no client organisation.');
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    // 404, not 403, for another org's campaign — a 403 confirms the id exists.
    if (!campaign || campaign.clientOrgId !== org.id) throw new NotFoundException('No such campaign.');
    return campaign;
  }

  // ── Per-campaign metrics (shared by detail + dashboard rows) ──

  /** Paid out of this campaign's escrow so far (fee + take). */
  private async spentMinor(campaign: Campaign): Promise<bigint> {
    if (!campaign.escrowAccountId) return 0n;
    const agg = await this.prisma.ledgerEntry.aggregate({
      where: {
        accountId: campaign.escrowAccountId,
        direction: 'DEBIT',
        transaction: { kind: LedgerTransactionKind.SUBMISSION_PAYOUT },
      },
      _sum: { amountMinor: true },
    });
    return agg._sum.amountMinor ?? 0n;
  }

  /** Non-bot clicks on every tracking link belonging to this campaign. */
  private async viewsFor(campaignId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM click_events c
      JOIN assignments a ON a.tracking_token = c.token
      WHERE a.campaign_id = ${campaignId}::uuid AND c.is_bot = false`;
    return Number(rows[0]?.count ?? 0n);
  }

  private async completedCount(campaignId: string): Promise<number> {
    return this.prisma.assignment.count({
      where: { campaignId, status: AssignmentStatus.PAID },
    });
  }

  // ── Campaign analytics (handoff §6) ──────────────────────

  async campaignAnalytics(userId: string, campaignId: string): Promise<CampaignAnalyticsDto> {
    const campaign = await this.ownedCampaign(userId, campaignId);

    const [spent, views, completed, offersSent, offersAccepted, clicks] = await Promise.all([
      this.spentMinor(campaign),
      this.viewsFor(campaignId),
      this.completedCount(campaignId),
      this.prisma.offer.count({ where: { campaignId } }),
      this.prisma.offer.count({ where: { campaignId, status: OfferStatus.ACCEPTED } }),
      this.prisma.clickEvent.count({ where: { isBot: false, trackingLink: { assignment: { campaignId } } } }),
    ]);

    // Integer-kobo cost per view; floor is fine for a display metric.
    const costPerView = views > 0 ? spent / BigInt(views) : 0n;
    const acceptanceRate = offersSent > 0 ? round2(offersAccepted / offersSent) : 0;

    return {
      campaign_id: campaign.id,
      name: campaign.name,
      objective: campaign.objective,
      status: campaign.status,
      launched_at: campaign.startsAt ? campaign.startsAt.toISOString() : null,
      spent: toMoney(spent),
      budget: toMoney(campaign.budgetMinor),
      views_delivered: views,
      clicks_delivered: clicks,
      cost_per_view: toMoney(costPerView),
      offers_sent: offersSent,
      offers_accepted: offersAccepted,
      acceptance_rate: acceptanceRate,
      completed,
      slots_total: campaign.slotsTotal,
      // Success rate: verified reach delivered against the reach the client paid for.
      target_reach: campaign.targetReach,
      success_rate_pct: campaign.targetReach > 0 ? Math.round((views / campaign.targetReach) * 100) : 0,
      evidence: await this.evidenceGallery(campaignId),
    };
  }

  /** Approved-or-pending submissions, newest first, with per-promoter view counts. */
  private async evidenceGallery(campaignId: string): Promise<EvidenceItemDto[]> {
    const submissions = await this.prisma.submission.findMany({
      where: { assignment: { campaignId } },
      orderBy: { submittedAt: 'desc' },
      include: {
        artifacts: { include: { file: true }, take: 1 },
        assignment: {
          include: {
            channel: { select: { platform: true, handle: true } },
            promoter: { include: { promoterProfile: { select: { fullName: true } } } },
          },
        },
      },
    });

    // View counts per tracking token, in one query rather than per submission.
    const tokens = submissions.map((s) => s.assignment.trackingToken);
    const viewsByToken = await this.viewsByToken(tokens);

    return Promise.all(
      submissions.map(async (s) => {
        const artifact = s.artifacts[0];
        return {
          submission_id: s.id,
          promoter_name: s.assignment.promoter.promoterProfile?.fullName ?? null,
          promoter_handle: s.assignment.channel.handle,
          platform: s.assignment.channel.platform,
          submitted_at: s.submittedAt.toISOString(),
          views: viewsByToken.get(s.assignment.trackingToken) ?? 0,
          verdict: s.verdict,
          auto_flag: s.autoFlag,
          public_url: s.publicUrl,
          image_url: artifact?.file ? `/v1/files/${artifact.file.id}` : null,
        };
      }),
    );
  }

  private async viewsByToken(tokens: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (tokens.length === 0) return out;
    const rows = await this.prisma.clickEvent.groupBy({
      by: ['token'],
      where: { token: { in: tokens }, isBot: false },
      _count: { _all: true },
    });
    for (const r of rows) out.set(r.token, r._count._all);
    return out;
  }

  // ── Dashboard summary ────────────────────────────────────

  async dashboardSummary(userId: string): Promise<DashboardSummaryDto> {
    const org = await this.prisma.clientOrg.findFirst({ where: { ownerUserId: userId } });
    if (!org) throw new ForbiddenException('This account has no client organisation.');

    const campaigns = await this.prisma.campaign.findMany({
      where: { clientOrgId: org.id },
      orderBy: { createdAt: 'desc' },
    });

    const rows: DashboardCampaignRowDto[] = [];
    let viewsTotal = 0;
    for (const c of campaigns) {
      const [spent, views, completed] = await Promise.all([
        this.spentMinor(c),
        this.viewsFor(c.id),
        this.completedCount(c.id),
      ]);
      viewsTotal += views;
      rows.push({
        id: c.id,
        name: c.name,
        objective: c.objective,
        status: c.status,
        slots_total: c.slotsTotal,
        spent: toMoney(spent),
        budget: toMoney(c.budgetMinor),
        views,
        completed,
      });
    }

    const escrowIds = campaigns.map((c) => c.escrowAccountId).filter((id): id is string => id !== null);
    const { thisMonth, lastMonth } = await this.monthlySpend(escrowIds);
    const changePct =
      lastMonth > 0n ? round2((Number(thisMonth) - Number(lastMonth)) / Number(lastMonth) * 100) : null;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [promotersWorkedWith, newEvidenceToday] = await Promise.all([
      this.distinctPromoters(org.id),
      this.prisma.submission.count({
        where: { assignment: { campaign: { clientOrgId: org.id } }, submittedAt: { gte: startOfToday } },
      }),
    ]);

    return {
      spent_this_month: toMoney(thisMonth),
      spent_change_pct: changePct,
      views_delivered: viewsTotal,
      campaigns_total: campaigns.length,
      live_campaigns: campaigns.filter((c) => c.status === 'LIVE').length,
      promoters_worked_with: promotersWorkedWith,
      new_evidence_today: newEvidenceToday,
      campaigns: rows,
    };
  }

  private async monthlySpend(escrowIds: string[]): Promise<{ thisMonth: bigint; lastMonth: bigint }> {
    if (escrowIds.length === 0) return { thisMonth: 0n, lastMonth: 0n };

    const now = new Date();
    const startThis = new Date(now.getFullYear(), now.getMonth(), 1);
    const startLast = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const sumBetween = async (from: Date, to: Date): Promise<bigint> => {
      const agg = await this.prisma.ledgerEntry.aggregate({
        where: {
          accountId: { in: escrowIds },
          direction: 'DEBIT',
          transaction: { kind: LedgerTransactionKind.SUBMISSION_PAYOUT, createdAt: { gte: from, lt: to } },
        },
        _sum: { amountMinor: true },
      });
      return agg._sum.amountMinor ?? 0n;
    };

    return {
      thisMonth: await sumBetween(startThis, now),
      lastMonth: await sumBetween(startLast, startThis),
    };
  }

  private async distinctPromoters(orgId: string): Promise<number> {
    const rows = await this.prisma.assignment.findMany({
      where: { campaign: { clientOrgId: orgId } },
      distinct: ['promoterId'],
      select: { promoterId: true },
    });
    return rows.length;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
