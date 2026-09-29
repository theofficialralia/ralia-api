import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { AdminCapability, Role } from '@prisma/client';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthedUser, Public } from '../../common/auth/jwt-auth.guard';
import { RequiresCapability, Roles } from '../../common/auth/roles.guard';
import { AcceptAdminInviteDto, InviteAdminDto, UpdateAdminCapabilitiesDto } from './dto/admin.dto';
import { TeamService } from './team.service';

/**
 * Admin team management (§7 RBAC). Every management route requires the MANAGE_TEAM
 * capability; accepting an invite is public (the invitee has no account yet).
 */
@ApiTags('admin: team')
@Controller('admin/team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Post('invites')
  @ApiBearerAuth('access-token')
  @Roles(Role.ADMIN)
  @RequiresCapability(AdminCapability.MANAGE_TEAM)
  @ApiOperation({ summary: 'Invite someone to the admin team' })
  invite(@CurrentUser() admin: AuthedUser, @Body() dto: InviteAdminDto) {
    return this.team.invite(admin.id, dto.email, dto.capabilities);
  }

  @Post('invites/:id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @Roles(Role.ADMIN)
  @RequiresCapability(AdminCapability.MANAGE_TEAM)
  @ApiOperation({ summary: 'Revoke a pending invite' })
  revoke(@CurrentUser() admin: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.team.revokeInvite(admin.id, id);
  }

  @Patch(':userId/capabilities')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @Roles(Role.ADMIN)
  @RequiresCapability(AdminCapability.MANAGE_TEAM)
  @ApiOperation({ summary: "Change an admin's capabilities" })
  updateCapabilities(@CurrentUser() admin: AuthedUser, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: UpdateAdminCapabilitiesDto) {
    return this.team.updateCapabilities(admin.id, userId, dto.capabilities);
  }

  @Post(':userId/suspend')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @Roles(Role.ADMIN)
  @RequiresCapability(AdminCapability.MANAGE_TEAM)
  @ApiOperation({ summary: 'Suspend an admin' })
  suspend(@CurrentUser() admin: AuthedUser, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.team.setActive(admin.id, userId, false);
  }

  @Post(':userId/reactivate')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @Roles(Role.ADMIN)
  @RequiresCapability(AdminCapability.MANAGE_TEAM)
  @ApiOperation({ summary: 'Reactivate a suspended admin' })
  reactivate(@CurrentUser() admin: AuthedUser, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.team.setActive(admin.id, userId, true);
  }

  @Public()
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept an admin invitation', description: 'Sets a password, creates/upgrades the admin account, and logs in.' })
  accept(@Body() dto: AcceptAdminInviteDto, @Req() req: Request) {
    return this.team.accept(dto.token, dto.password, req.headers['user-agent']);
  }
}
