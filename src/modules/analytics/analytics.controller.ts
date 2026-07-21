import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.guard';
import { AnalyticsService } from './analytics.service';
import { CampaignAnalyticsDto, DashboardSummaryDto } from './dto/analytics.dto';

@ApiTags('analytics')
@ApiBearerAuth('access-token')
@Roles(Role.CLIENT)
@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('dashboard/summary')
  @ApiOperation({
    summary: 'Client dashboard summary',
    description: 'Top-line spend, views and promoter counts, plus a per-campaign rollup for the table.',
  })
  @ApiOkResponse({ type: DashboardSummaryDto })
  summary(@CurrentUser() user: AuthedUser): Promise<DashboardSummaryDto> {
    return this.analytics.dashboardSummary(user.id);
  }

  @Get('campaigns/:id/analytics')
  @ApiOperation({
    summary: 'Campaign analytics and evidence gallery',
    description:
      'Views delivered, offer acceptance, completion, amount spent, and every verified/pending submission with its screenshot — the four SOW metrics plus the evidence gallery (handoff §6).',
  })
  @ApiOkResponse({ type: CampaignAnalyticsDto })
  campaign(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampaignAnalyticsDto> {
    return this.analytics.campaignAnalytics(user.id, id);
  }
}
