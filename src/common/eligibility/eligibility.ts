import { ChannelStatus, Prisma, PromoterStatus } from '@prisma/client';
import { TargetingFilters } from '../pricing/pricing';

/**
 * The §5.3 stage-1 hard filter, as Prisma where-clauses. One definition, used by
 * both the campaign quote estimate (B4) and the admin candidates list (B5) — if
 * these two ever diverged, a quote would promise a different eligible set than
 * the admin is shown.
 *
 * Every targeting clause is conditional: an empty targeting field means "no
 * constraint", not "match nothing". A channel qualifies only if ACTIVE, meeting
 * the platform and reach floor; a promoter qualifies only if ACTIVE, trusted
 * enough, matching demographics, and holding at least one qualifying channel.
 */
export function buildEligibility(
  filters: TargetingFilters,
  minTrustScore: number,
): { channelWhere: Prisma.ChannelWhereInput; profileWhere: Prisma.PromoterProfileWhereInput } {
  const channelWhere: Prisma.ChannelWhereInput = {
    status: ChannelStatus.ACTIVE,
    adminFrozen: false,
    effectiveReach: { gte: filters.minEffectiveReach },
    ...(filters.platforms.length > 0 ? { platform: { in: filters.platforms as never } } : {}),
  };

  const profileWhere: Prisma.PromoterProfileWhereInput = {
    status: PromoterStatus.ACTIVE,
    trustScore: { gte: minTrustScore },
    ...(filters.states.length > 0 ? { locationState: { in: filters.states } } : {}),
    ...(filters.ageMin !== null ? { age: { gte: filters.ageMin } } : {}),
    ...(filters.ageMax !== null ? { age: { lte: filters.ageMax } } : {}),
    ...(filters.languages.length > 0 ? { languagesSpoken: { hasSome: filters.languages } } : {}),
    user: { channels: { some: channelWhere } },
  };

  return { channelWhere, profileWhere };
}
