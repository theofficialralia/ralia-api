import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AdminCapability, AdminInviteStatus, Role, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { MAILER, Mailer } from '../../common/mailer/mailer';
import { renderBrandedEmail } from '../../common/mailer/email-template';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TokenPairDto } from '../identity/dto/auth.dto';
import { SessionService } from '../identity/session.service';
import { AuditService } from './audit.service';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const adminUrl = (process.env.ADMIN_APP_URL ?? 'http://localhost:6200').replace(/\/+$/, '');
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Team management (§7 RBAC): invite people to the admin team with specific
 * capabilities, accept the invite to become an admin, and edit or suspend
 * teammates. Guarded by the MANAGE_TEAM capability; a safety rail forbids removing
 * the team's last person who can manage it.
 */
@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  /** Invite someone by email with a capability set; emails them a one-time accept link. */
  async invite(inviterId: string, emailRaw: string, capabilities: AdminCapability[]) {
    const email = emailRaw.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email }, include: { roles: true } });
    if (existing?.roles.some((r) => r.role === Role.ADMIN)) {
      throw new ConflictException('That person is already on the admin team.');
    }
    const pending = await this.prisma.adminInvite.findFirst({ where: { email, status: AdminInviteStatus.PENDING } });
    if (pending) throw new ConflictException('There is already a pending invite for that email.');

    const token = randomBytes(32).toString('base64url');
    const invite = await this.prisma.adminInvite.create({
      data: {
        email,
        capabilities,
        tokenHash: sha256(token),
        invitedById: inviterId,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });

    const link = `${adminUrl}/accept-invite?token=${token}`;
    await this.mailer.send({
      to: email,
      subject: 'You’re invited to the Ralia admin team',
      html: renderBrandedEmail({
        heading: 'Join the Ralia admin team',
        paragraphs: [
          'You’ve been invited to help run Ralia as an administrator.',
          'Click below to set your password and accept the invitation. This link expires in 7 days.',
        ],
        cta: { label: 'Accept invitation', url: link },
        preheader: 'Set your password and join the Ralia admin team.',
      }),
      text: `You’ve been invited to the Ralia admin team. Accept here (expires in 7 days): ${link}`,
    });

    await this.audit.record({
      actorId: inviterId,
      action: 'admin.team.invite',
      entityType: 'admin_invite',
      entityId: invite.id,
      after: { email, capabilities },
    });

    return { id: invite.id, email: invite.email, capabilities: invite.capabilities, expires_at: invite.expiresAt.toISOString() };
  }

  async revokeInvite(actorId: string, id: string): Promise<void> {
    const invite = await this.prisma.adminInvite.findUnique({ where: { id } });
    if (!invite) throw new NotFoundException('No such invite.');
    if (invite.status !== AdminInviteStatus.PENDING) throw new BadRequestException('That invite is no longer pending.');
    await this.prisma.adminInvite.update({ where: { id }, data: { status: AdminInviteStatus.REVOKED } });
    await this.audit.record({ actorId, action: 'admin.team.invite.revoke', entityType: 'admin_invite', entityId: id });
  }

  /** Accept an invite: create (or upgrade) the user to an admin and log them in. */
  async accept(token: string, password: string, userAgent?: string): Promise<TokenPairDto> {
    const invite = await this.prisma.adminInvite.findFirst({
      where: { tokenHash: sha256(token), status: AdminInviteStatus.PENDING },
    });
    if (!invite || invite.expiresAt < new Date()) {
      throw new BadRequestException('This invitation is invalid or has expired.');
    }
    if (password.length < 10) throw new BadRequestException('Choose a password of at least 10 characters.');

    const passwordHash = await argon2.hash(password);
    const userId = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email: invite.email } });
      let id: string;
      if (existing) {
        // Upgrade an existing account to admin — don't touch their password.
        await tx.userRole.upsert({
          where: { userId_role: { userId: existing.id, role: Role.ADMIN } },
          create: { userId: existing.id, role: Role.ADMIN, capabilities: invite.capabilities },
          update: { capabilities: invite.capabilities },
        });
        if (existing.status !== UserStatus.ACTIVE) {
          await tx.user.update({ where: { id: existing.id }, data: { status: UserStatus.ACTIVE } });
        }
        id = existing.id;
      } else {
        const created = await tx.user.create({
          data: {
            email: invite.email,
            passwordHash,
            status: UserStatus.ACTIVE,
            emailVerifiedAt: new Date(),
            roles: { create: { role: Role.ADMIN, capabilities: invite.capabilities } },
          },
        });
        id = created.id;
      }
      await tx.adminInvite.update({ where: { id: invite.id }, data: { status: AdminInviteStatus.ACCEPTED, acceptedAt: new Date() } });
      return id;
    });

    const roles = await this.prisma.userRole.findMany({ where: { userId }, select: { role: true } });
    return this.sessions.issue(userId, roles.map((r) => r.role), userAgent);
  }

  async updateCapabilities(actorId: string, userId: string, capabilities: AdminCapability[]): Promise<void> {
    const role = await this.prisma.userRole.findUnique({ where: { userId_role: { userId, role: Role.ADMIN } } });
    if (!role) throw new NotFoundException('That user is not an admin.');
    // Don't let the team strand itself with no one who can manage it.
    if (role.capabilities.includes(AdminCapability.MANAGE_TEAM) && !capabilities.includes(AdminCapability.MANAGE_TEAM)) {
      await this.assertNotLastManager(userId);
    }
    await this.prisma.userRole.update({ where: { userId_role: { userId, role: Role.ADMIN } }, data: { capabilities } });
    await this.audit.record({ actorId, action: 'admin.team.capabilities', entityType: 'user', entityId: userId, after: { capabilities } });
  }

  async setActive(actorId: string, userId: string, active: boolean): Promise<void> {
    if (userId === actorId && !active) throw new BadRequestException('You cannot suspend your own account.');
    const role = await this.prisma.userRole.findUnique({ where: { userId_role: { userId, role: Role.ADMIN } } });
    if (!role) throw new NotFoundException('That user is not an admin.');
    if (!active && role.capabilities.includes(AdminCapability.MANAGE_TEAM)) {
      await this.assertNotLastManager(userId);
    }
    await this.prisma.user.update({ where: { id: userId }, data: { status: active ? UserStatus.ACTIVE : UserStatus.SUSPENDED } });
    await this.audit.record({ actorId, action: active ? 'admin.team.reactivate' : 'admin.team.suspend', entityType: 'user', entityId: userId });
  }

  /** Guards against removing the last active admin who can manage the team. */
  private async assertNotLastManager(excludingUserId: string): Promise<void> {
    const managers = await this.prisma.userRole.count({
      where: {
        role: Role.ADMIN,
        capabilities: { has: AdminCapability.MANAGE_TEAM },
        userId: { not: excludingUserId },
        user: { status: UserStatus.ACTIVE },
      },
    });
    if (managers === 0) {
      throw new ForbiddenException('This is the last admin who can manage the team — grant MANAGE_TEAM to someone else first.');
    }
  }
}
