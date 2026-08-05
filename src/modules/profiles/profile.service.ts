import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConsentPurpose, Prisma, PromoterProfile, PromoterStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SELF_REPORTED_CAPABILITY_FACTORS } from '../../common/scoring/scoring';
import { ProfileDto, UpdateProfileDto } from './dto/profile.dto';

const ALLOWED_FACTORS: ReadonlySet<string> = new Set(SELF_REPORTED_CAPABILITY_FACTORS);

/** Reject unknown factor keys / out-of-range values so a client can't inject junk or inflate itself. */
function sanitizeCapabilityInputs(inputs: Record<string, unknown>): Record<string, number> {
  const clean: Record<string, number> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (!ALLOWED_FACTORS.has(key)) throw new BadRequestException(`Unknown capability factor: ${key}`);
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) {
      throw new BadRequestException(`Capability factor ${key} must be a number in [0, 1].`);
    }
    clean[key] = value;
  }
  return clean;
}

/**
 * Fields a promoter must supply before an admin can meaningfully review them.
 *
 * This is the thin set: what §5.3's filter reads, plus a name — an approval
 * queue of anonymous rows is not reviewable. The rest of the questionnaire
 * (education, occupation, religion, travel, …) exists in the schema and lands in
 * the B3 harden slice.
 */
const REQUIRED_FIELDS = [
  'full_name',
  'dob',
  'location_state',
  'languages_spoken',
  'preferred_categories',
] as const;

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<ProfileDto> {
    const profile = await this.prisma.promoterProfile.findUnique({ where: { userId } });
    if (!profile) throw new NotFoundException('No promoter profile for this account.');
    const channelCount = await this.prisma.channel.count({ where: { promoterId: userId } });
    return this.toDto(profile, channelCount);
  }

  /**
   * Partial, resumable save. Only the keys present are written, so a promoter can
   * fill the questionnaire over several sittings without losing what they had.
   */
  async update(userId: string, dto: UpdateProfileDto): Promise<ProfileDto> {
    const existing = await this.prisma.promoterProfile.findUnique({ where: { userId } });
    if (!existing) throw new NotFoundException('No promoter profile for this account.');

    const data: Prisma.PromoterProfileUpdateInput = {};

    if (dto.full_name !== undefined) data.fullName = dto.full_name;
    if (dto.location_state !== undefined) data.locationState = dto.location_state;
    if (dto.languages_spoken !== undefined) data.languagesSpoken = dto.languages_spoken;
    if (dto.preferred_categories !== undefined) data.preferredCategories = dto.preferred_categories;
    if (dto.max_campaigns_per_week !== undefined) data.maxCampaignsPerWeek = dto.max_campaigns_per_week;
    if (dto.gender !== undefined) data.gender = dto.gender;
    if (dto.roles !== undefined) data.roles = { set: dto.roles };
    if (dto.capability_inputs !== undefined) data.capabilityInputs = sanitizeCapabilityInputs(dto.capability_inputs);

    if (dto.dob !== undefined) {
      const dob = new Date(dto.dob);
      data.dob = dob;
      // Derived, never accepted from the client — otherwise a promoter could
      // claim an age that doesn't match their date of birth and slip a filter.
      data.age = ageFrom(dob);
    }

    const profile = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.promoterProfile.update({ where: { userId }, data });

      // Consent is captured where the data is collected — handoff §7 wants these
      // fields individually revocable, which needs a row per field, not one
      // blanket agreement at signup.
      if (dto.dob !== undefined) await this.recordConsent(tx, userId, ConsentPurpose.DATA_DOB);
      if (dto.gender !== undefined) await this.recordConsent(tx, userId, ConsentPurpose.DATA_GENDER);

      return updated;
    });

    return this.maybeSubmitForApproval(userId, profile);
  }

  /**
   * Moves PROFILE_INCOMPLETE → AWAITING_APPROVAL once there is something to
   * approve. Called after a profile save and after a channel changes, because
   * either can complete the picture.
   */
  async maybeSubmitForApproval(userId: string, profile?: PromoterProfile): Promise<ProfileDto> {
    const current = profile ?? (await this.prisma.promoterProfile.findUnique({ where: { userId } }));
    if (!current) throw new NotFoundException('No promoter profile for this account.');

    const channelCount = await this.prisma.channel.count({ where: { promoterId: userId } });
    const { complete } = this.completeness(current, channelCount);

    // Only ever promotes out of PROFILE_INCOMPLETE. A REJECTED or ACTIVE promoter
    // editing their profile must not silently re-enter the queue or lose
    // their approval — that is an admin decision (B8).
    if (complete && current.status === PromoterStatus.PROFILE_INCOMPLETE) {
      const updated = await this.prisma.promoterProfile.update({
        where: { userId },
        data: { status: PromoterStatus.AWAITING_APPROVAL },
      });
      return this.toDto(updated, channelCount);
    }

    return this.toDto(current, channelCount);
  }

  private completeness(
    profile: PromoterProfile,
    channelCount: number,
  ): { complete: boolean; missing: string[] } {
    const value: Record<(typeof REQUIRED_FIELDS)[number], unknown> = {
      full_name: profile.fullName,
      dob: profile.dob,
      location_state: profile.locationState,
      languages_spoken: profile.languagesSpoken,
      preferred_categories: profile.preferredCategories,
    };

    const missing = REQUIRED_FIELDS.filter((field) => {
      const v = value[field];
      if (Array.isArray(v)) return v.length === 0;
      return v === null || v === undefined || v === '';
    }).map(String);

    // A promoter with no channel has nothing to promote on and cannot match any
    // campaign, so there is nothing for an admin to approve.
    if (channelCount === 0) missing.push('channels');

    return { complete: missing.length === 0, missing };
  }

  private async recordConsent(
    tx: Prisma.TransactionClient,
    userId: string,
    purpose: ConsentPurpose,
  ): Promise<void> {
    const policyVersion = process.env.POLICY_VERSION ?? '2026-07-01';
    const existing = await tx.consent.findFirst({ where: { userId, purpose } });

    if (existing) {
      await tx.consent.update({
        where: { id: existing.id },
        data: { granted: true, grantedAt: new Date(), revokedAt: null, policyVersion },
      });
      return;
    }
    await tx.consent.create({
      data: { userId, purpose, granted: true, grantedAt: new Date(), policyVersion },
    });
  }

  private toDto(profile: PromoterProfile, channelCount: number): ProfileDto {
    const { complete, missing } = this.completeness(profile, channelCount);
    return {
      user_id: profile.userId,
      status: profile.status,
      full_name: profile.fullName,
      dob: profile.dob ? profile.dob.toISOString().slice(0, 10) : null,
      age: profile.age,
      gender: profile.gender,
      location_state: profile.locationState,
      languages_spoken: profile.languagesSpoken,
      preferred_categories: profile.preferredCategories,
      max_campaigns_per_week: profile.maxCampaignsPerWeek,
      trust_score: profile.trustScore.toNumber(),
      roles: profile.roles,
      capability_inputs: (profile.capabilityInputs as Record<string, number> | null) ?? null,
      capability_scores: (profile.capabilityScores as Record<string, number> | null) ?? null,
      complete,
      missing,
    };
  }
}

/** Whole years elapsed, accounting for whether this year's birthday has passed. */
export function ageFrom(dob: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}
