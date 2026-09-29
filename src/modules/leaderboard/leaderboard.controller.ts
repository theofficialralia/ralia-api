import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.guard';
import { LeaderboardDto, MyScoreDto, PointRulesDto } from './dto/leaderboard.dto';
import { LeaderboardService } from './leaderboard.service';

@ApiTags('leaderboard')
@ApiBearerAuth('access-token')
@Roles(Role.PROMOTER)
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  @ApiOperation({ summary: 'The season leaderboard', description: 'Top promoters this season plus the caller’s own ranked row.' })
  @ApiOkResponse({ type: LeaderboardDto })
  board(
    @CurrentUser() user: AuthedUser,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ): Promise<LeaderboardDto> {
    return this.leaderboard.board(user.id, Math.min(Math.max(limit, 1), 100));
  }

  @Get('me')
  @ApiOperation({ summary: 'My score', description: 'Points, rank, tier + progress to the next tier, streak, and a breakdown of how points were earned this season.' })
  @ApiOkResponse({ type: MyScoreDto })
  me(@CurrentUser() user: AuthedUser): Promise<MyScoreDto> {
    return this.leaderboard.myScore(user.id);
  }

  @Get('rules')
  @ApiOperation({ summary: 'How points work', description: 'The current point values — what earns and what costs points — for a promoter-facing explainer.' })
  @ApiOkResponse({ type: PointRulesDto })
  rules(): Promise<PointRulesDto> {
    return this.leaderboard.rules();
  }
}
