import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.guard';
import { BankService } from './bank.service';
import { ChannelsService } from './channels.service';
import {
  BankAccountDto,
  ChannelDto,
  CreateBankAccountDto,
  CreateChannelDto,
  ProfileDto,
  UpdateProfileDto,
} from './dto/profile.dto';
import { ProfileService } from './profile.service';

@ApiTags('promoters')
@ApiBearerAuth('access-token')
@Roles(Role.PROMOTER)
@Controller('promoters/me')
export class PromotersController {
  constructor(
    private readonly profiles: ProfileService,
    private readonly channels: ChannelsService,
    private readonly bank: BankService,
  ) {}

  @Get('profile')
  @ApiOperation({ summary: 'The current promoter profile, with what is still outstanding' })
  @ApiOkResponse({ type: ProfileDto })
  getProfile(@CurrentUser() user: AuthedUser): Promise<ProfileDto> {
    return this.profiles.get(user.id);
  }

  @Put('profile')
  @ApiOperation({
    summary: 'Save the questionnaire, partially',
    description:
      'Only the fields present are written, so the questionnaire resumes across sittings. Once everything required is present and at least one channel exists, the profile moves to AWAITING_APPROVAL by itself.',
  })
  @ApiOkResponse({ type: ProfileDto })
  updateProfile(@CurrentUser() user: AuthedUser, @Body() dto: UpdateProfileDto): Promise<ProfileDto> {
    return this.profiles.update(user.id, dto);
  }

  @Get('channels')
  @ApiOperation({ summary: 'List channels' })
  @ApiOkResponse({ type: [ChannelDto] })
  listChannels(@CurrentUser() user: AuthedUser): Promise<ChannelDto[]> {
    return this.channels.list(user.id);
  }

  @Post('channels')
  @ApiOperation({
    summary: 'Add a channel',
    description: 'Returns the computed effective_reach (§5.1). Reach and verification tier are server-set.',
  })
  @ApiCreatedResponse({ type: ChannelDto })
  createChannel(@CurrentUser() user: AuthedUser, @Body() dto: CreateChannelDto): Promise<ChannelDto> {
    return this.channels.create(user.id, dto);
  }

  @Delete('channels/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a channel' })
  @ApiNoContentResponse()
  removeChannel(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.channels.remove(user.id, id);
  }

  @Get('bank')
  @ApiOperation({ summary: 'List bank accounts (masked)' })
  @ApiOkResponse({ type: [BankAccountDto] })
  listBank(@CurrentUser() user: AuthedUser): Promise<BankAccountDto[]> {
    return this.bank.list(user.id);
  }

  @Post('bank')
  @ApiOperation({
    summary: 'Store bank details',
    description: 'The account number is encrypted at rest and never returned in full.',
  })
  @ApiCreatedResponse({ type: BankAccountDto })
  createBank(@CurrentUser() user: AuthedUser, @Body() dto: CreateBankAccountDto): Promise<BankAccountDto> {
    return this.bank.create(user.id, dto);
  }
}
