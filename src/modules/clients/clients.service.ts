import { ForbiddenException, Injectable } from '@nestjs/common';
import { ClientOrg, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClientProfileDto, UpdateClientProfileDto } from './dto/client-profile.dto';

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

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

    const updated = await this.prisma.clientOrg.update({ where: { id: org.id }, data });
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    return toDto(updated, user.email);
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
    status: org.status,
  };
}
