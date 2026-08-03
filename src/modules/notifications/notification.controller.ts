import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthedUser } from '../../common/auth/jwt-auth.guard';
import { NotificationListDto } from './dto/notification.dto';
import { NotificationService } from './notification.service';

/**
 * The signed-in user's own notification feed. No @Roles — every authenticated user
 * (promoter, client, admin) reads their own; every query is scoped to their id, so no
 * one can see or touch another's.
 */
@ApiTags('notifications')
@ApiBearerAuth('access-token')
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @ApiOperation({ summary: 'My notifications', description: 'Newest first, with the unread count for a badge.' })
  @ApiOkResponse({ type: NotificationListDto })
  list(@CurrentUser() user: AuthedUser, @Query('limit') limit?: string): Promise<NotificationListDto> {
    return this.notifications.list(user.id, limit ? Number(limit) : undefined);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark one notification read' })
  async markRead(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.notifications.markRead(user.id, id, new Date());
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all my notifications read' })
  async markAllRead(@CurrentUser() user: AuthedUser): Promise<{ marked: number }> {
    const marked = await this.notifications.markAllRead(user.id, new Date());
    return { marked };
  }
}
