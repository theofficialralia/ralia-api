import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.guard';
import { AssignmentDto, OfferDto } from './dto/matching.dto';
import { MatchingService } from './matching.service';

@ApiTags('offers')
@ApiBearerAuth('access-token')
@Roles(Role.PROMOTER)
@Controller('offers')
export class OffersController {
  constructor(private readonly matching: MatchingService) {}

  @Get()
  @ApiOperation({ summary: 'My live offers' })
  @ApiOkResponse({ type: [OfferDto] })
  list(@CurrentUser() user: AuthedUser): Promise<OfferDto[]> {
    return this.matching.listOffers(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One offer — details a promoter reviews before accepting' })
  detail(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.matching.offerDetail(user.id, id);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  // Accept is where a slot is reserved; rate-limit it against a burst from one user.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Accept an offer',
    description: 'Reserves a slot atomically and issues the assignment. 409 if the offer is stale or the campaign is full.',
  })
  @ApiOkResponse({ type: AssignmentDto })
  accept(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<AssignmentDto> {
    return this.matching.accept(id, user.id);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Decline an offer' })
  decline(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.matching.decline(id, user.id);
  }
}

@ApiTags('assignments')
@ApiBearerAuth('access-token')
@Roles(Role.PROMOTER)
@Controller('assignments')
export class AssignmentsController {
  constructor(private readonly matching: MatchingService) {}

  @Get()
  @ApiOperation({ summary: 'My assignments', description: 'The campaigns I accepted, with what to do and the latest verdict.' })
  myAssignments(@CurrentUser() user: AuthedUser) {
    return this.matching.myAssignments(user.id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One assignment in full',
    description: 'Everything to act on an accepted assignment: the matched channel, the click-recording tracking link, poster + caption, the earn range, and the latest submission.',
  })
  assignmentDetail(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.matching.assignmentDetail(user.id, id);
  }
}
