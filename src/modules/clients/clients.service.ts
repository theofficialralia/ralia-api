import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { CampaignStatus, ClientOrg, ClientOrgStatus, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../admin/audit.service';
import { ClientProfileDto, UpdateClientProfileDto } from './dto/client-profile.dto';

/** Campaign states where money or promoter work is still in flight. */
const ACTIVE_STATES: CampaignStatus[] = [
  CampaignStatus.CONFIRMING_PAYMENT,
  CampaignStatus.LIVE,
  CampaignStatus.PAUSED,
];

/** Draft-ish states that are simply cancelled when the account closes. */
const CANCELLABLE_STATES: CampaignStatus[] = [
  CampaignStatus.DRAFT,
  CampaignStatus.QUOTED,
  CampaignStatus.PENDING_APPROVAL,
  CampaignStatus.REJECTED,
];

@Injectable()
export class ClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async orgFor(userId: string): Promise<ClientOrg> {
    const org = await this.prisma.clientOrg.findFirst({ where: { ownerUserId: userId } });
    if (!org) throw new ForbiddenException('This account has no client organisation.');
    return org;
  }

  async me(userId: string): Promise<ClientProfileDto> {
    const org = await this.orgFor(userId);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    return toDto(org, user.email);
  }

  async update(userId: string, dto: UpdateClientProfileDto): Promise<ClientProfileDto> {
    const org = await this.orgFor(userId);

    const data: Prisma.ClientOrgUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.industry !== undefined) data.industry = dto.industry;
    if (dto.phone_whatsapp !== undefined) data.phoneWhatsapp = dto.phone_whatsapp;
    if (dto.website !== undefined) data.website = dto.website;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.cac_number !== undefined) data.cacNumber = dto.cac_number;
    if (dto.support_contact_name !== undefined) data.supportContactName = dto.support_contact_name;
    if (dto.support_contact_phone !== undefined) data.supportContactPhone = dto.support_contact_phone;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.social_platform !== undefined) data.socialPlatform = dto.social_platform;
    if (dto.social_url !== undefined) data.socialUrl = dto.social_url;
    if (dto.social_followers !== undefined) data.socialFollowers = dto.social_followers;

    const updated = await this.prisma.clientOrg.update({ where: { id: org.id }, data });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    return toDto(updated, user.email);
  }

  /**
   * Close the account. This is a §7 erasure: the user is anonymised and their
   * sessions revoked, but ledger postings are preserved — money history is never
   * deleted. Draft campaigns are cancelled; anything with money or promoter work
   * still in flight blocks the deletion until it is resolved.
   */
  async deleteAccount(userId: string): Promise<void> {
    const org = await this.orgFor(userId);

    const active = await this.prisma.campaign.count({
      where: { clientOrgId: org.id, status: { in: ACTIVE_STATES } },
    });
    if (active > 0) {
      throw new ConflictException(
        'You have active campaigns. Let them end or settle — with any balance withdrawn — before deleting your account.',
      );
    }

    // A unique, non-identifying token to free the email/phone for reuse.
    const tombstone = `deleted-${userId}-${randomBytes(4).toString('hex')}`;

    await this.prisma.$transaction(async (tx) => {
      await tx.campaign.updateMany({
        where: { clientOrgId: org.id, status: { in: CANCELLABLE_STATES } },
        data: { status: CampaignStatus.CANCELLED },
      });

      // Anonymise the org (keep the row so its campaigns/ledger references stay intact).
      await tx.clientOrg.update({
        where: { id: org.id },
        data: {
          name: 'Deleted business',
          status: ClientOrgStatus.SUSPENDED,
          phoneWhatsapp: null, website: null, address: null, cacNumber: null,
          supportContactName: null, supportContactPhone: null, description: null, logoFileId: null,
        },
      });

      // Anonymise the user and mark it deleted — the auth guard rejects any token
      // for a user with deletedAt set, so this closes every door immediately.
      await tx.user.update({
        where: { id: userId },
        data: {
          email: `${tombstone}@deleted.local`,
          phoneE164: tombstone,
          passwordHash: 'account-deleted',
          deletedAt: new Date(),
        },
      });

      await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });

      await this.audit.record(
        {
          actorId: userId,
          action: 'client.account.delete',
          entityType: 'user',
          entityId: userId,
          after: { anonymised: true, orgId: org.id },
        },
        tx,
      );
    });
  }
}

function toDto(org: ClientOrg, email: string): ClientProfileDto {
  return {
    org_id: org.id,
    name: org.name,
    email,
    industry: org.industry,
    phone_whatsapp: org.phoneWhatsapp,
    website: org.website,
    address: org.address,
    cac_number: org.cacNumber,
    support_contact_name: org.supportContactName,
    support_contact_phone: org.supportContactPhone,
    description: org.description,
    social_platform: org.socialPlatform,
    social_url: org.socialUrl,
    social_followers: org.socialFollowers,
    status: org.status,
  };
}
