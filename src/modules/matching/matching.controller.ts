import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/auth/roles.guard';
import { CandidateDto, OfferDto, SendOffersDto } from './dto/matching.dto';
import { MatchingService } from './matching.service';

/**
 * Admin-facing matching, under the campaign it acts on. The admin reviews the
 * ranked candidate list and sends the offers — no auto-send (§5.3).
 */
@ApiTags('matching (admin)')
@ApiBearerAuth('access-token')
@Roles(Role.ADMIN)
@Controller('campaigns/:id')
export class MatchingController {
  constructor(private readonly matching: MatchingService) {}

  @Get('candidates')
  @ApiOperation({ summary: 'Ranked eligible promoters for a campaign' })
  @ApiOkResponse({ type: [CandidateDto] })
  candidates(@Param('id', ParseUUIDPipe) id: string): Promise<CandidateDto[]> {
    return this.matching.candidates(id);
  }

  @Get('offers')
  @ApiOperation({ summary: 'Offer roster: who was offered, accepted or unanswered, with reach and fit' })
  offerRoster(@Param('id', ParseUUIDPipe) id: string) {
    return this.matching.campaignOfferRoster(id);
  }

  @Post('offers')
  @ApiOperation({ summary: 'Send offers to selected promoters' })
  @ApiCreatedResponse({ type: [OfferDto] })
  sendOffers(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SendOffersDto): Promise<OfferDto[]> {
    return this.matching.sendOffers(id, dto.promoter_ids);
  }
}
