import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Channel, ChannelStatus, Platform, VerificationTier } from '@prisma/client';
import { channelEffectiveReach } from '../../common/reach/effective-reach';
import { RateConfigService } from '../../common/rate-config/rate-config.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ChannelDto, CreateChannelDto } from './dto/profile.dto';
import { ProfileService } from './profile.service';

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateConfig: RateConfigService,
    private readonly profiles: ProfileService,
  ) {}

  async list(promoterId: string): Promise<ChannelDto[]> {
    const channels = await this.prisma.channel.findMany({
      where: { promoterId },
      orderBy: { createdAt: 'asc' },
    });
    return channels.map(toDto);
  }

  async create(promoterId: string, dto: CreateChannelDto): Promise<ChannelDto> {
    if (dto.is_group && dto.group_members === undefined) {
      throw new BadRequestException('group_members is required for a group channel.');
    }
    if (dto.active_participants !== undefined && dto.group_members !== undefined) {
      if (dto.active_participants > dto.group_members) {
        throw new BadRequestException('active_participants cannot exceed group_members.');
      }
    }

    const policy = await this.rateConfig.getReachPolicy();

    // Tier is SELF on creation, always. The promoter uploads evidence and an
    // admin verifies it (B8); a client-settable tier would let a promoter apply
    // their own 1.15× multiplier and price their own slot.
    const verificationTier = VerificationTier.SELF;
    const isGroup = dto.is_group ?? false;
    const activeParticipants = dto.active_participants ?? null;

    const channel = await this.prisma.channel.create({
      data: {
        promoterId,
        platform: dto.platform,
        handle: dto.handle ?? null,
        url: dto.url ?? null,
        claimedAudience: dto.claimed_audience,
        isGroup,
        isGroupAdmin: dto.is_group_admin ?? false,
        groupMembers: dto.group_members ?? null,
        activeParticipants,
        verificationTier,
        // §1: groups count active participants; self-reported reach is capped.
        effectiveReach: channelEffectiveReach(
          { platform: dto.platform, claimedAudience: dto.claimed_audience, isGroup, activeParticipants, verificationTier, verifiedAt: null },
          policy,
          new Date(),
        ),
        status: ChannelStatus.PENDING_REVIEW,
      },
    });

    // Adding a first channel can be what completes the profile.
    await this.profiles.maybeSubmitForApproval(promoterId);

    return toDto(channel);
  }

  async remove(promoterId: string, channelId: string): Promise<void> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel || channel.promoterId !== promoterId) {
      // Same response whether it doesn't exist or belongs to someone else —
      // otherwise this enumerates other promoters' channel ids.
      throw new NotFoundException('No such channel.');
    }
    if (channel.adminFrozen) {
      throw new ForbiddenException('This channel is frozen and cannot be removed.');
    }

    const active = await this.prisma.assignment.count({
      where: { channelId, status: { in: ['IN_PROGRESS', 'SUBMITTED', 'APPROVED'] } },
    });
    if (active > 0) {
      throw new BadRequestException(
        'This channel has work in progress. Finish or cancel those assignments first.',
      );
    }

    await this.prisma.channel.delete({ where: { id: channelId } });
  }

  /**
   * Recomputes stored reach — §5.1 says to recompute when the claim or tier
   * changes. The tier changes when an admin verifies evidence (B8), so this is
   * the hook that keeps the stored value honest.
   */
  async recomputeReach(channelId: string): Promise<number> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException('No such channel.');

    const policy = await this.rateConfig.getReachPolicy();
    const effectiveReach = channelEffectiveReach(
      {
        platform: channel.platform,
        claimedAudience: channel.claimedAudience,
        isGroup: channel.isGroup,
        activeParticipants: channel.activeParticipants,
        verificationTier: channel.verificationTier,
        verifiedAt: channel.verifiedAt,
      },
      policy,
      new Date(),
    );

    await this.prisma.channel.update({ where: { id: channelId }, data: { effectiveReach } });
    return effectiveReach;
  }
}

function toDto(channel: Channel): ChannelDto {
  return {
    id: channel.id,
    platform: channel.platform as Platform,
    handle: channel.handle,
    url: channel.url,
    claimed_audience: channel.claimedAudience,
    verification_tier: channel.verificationTier,
    effective_reach: channel.effectiveReach,
    status: channel.status,
    admin_frozen: channel.adminFrozen,
  };
}
