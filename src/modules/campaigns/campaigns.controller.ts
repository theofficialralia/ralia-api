import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.guard';
import { AssetsService, AssetView } from './assets.service';
import { CampaignsService } from './campaigns.service';
import {
  AssetMetaDto,
  CampaignDto,
  CampaignPlanDto,
  CreateCampaignDto,
  PlanRequestDto,
  QuoteDto,
  SetTargetingDto,
  UpdateCampaignDto,
} from './dto/campaign.dto';

@ApiTags('campaigns')
@ApiBearerAuth('access-token')
@Roles(Role.CLIENT)
@Controller('campaigns')
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly assets: AssetsService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a draft campaign' })
  @ApiCreatedResponse({ type: CampaignDto })
  create(@CurrentUser() user: AuthedUser, @Body() dto: CreateCampaignDto): Promise<CampaignDto> {
    return this.campaigns.create(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List my campaigns' })
  @ApiOkResponse({ type: [CampaignDto] })
  list(@CurrentUser() user: AuthedUser): Promise<CampaignDto[]> {
    return this.campaigns.list(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one campaign' })
  @ApiOkResponse({ type: CampaignDto })
  get(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<CampaignDto> {
    return this.campaigns.get(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a draft', description: 'Editing a quoted campaign returns it to DRAFT and clears the stale price.' })
  @ApiOkResponse({ type: CampaignDto })
  update(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampaignDto,
  ): Promise<CampaignDto> {
    return this.campaigns.update(user.id, id, dto);
  }

  @Put(':id/targeting')
  @ApiOperation({ summary: 'Set targeting' })
  @ApiOkResponse({ type: CampaignDto })
  setTargeting(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetTargetingDto,
  ): Promise<CampaignDto> {
    return this.campaigns.setTargeting(user.id, id, dto);
  }

  @Post(':id/quote')
  @ApiOperation({
    summary: 'Price the campaign',
    description:
      'Returns price, per-slot fee, estimated reach and eligible promoter count. Freezes the price and moves the campaign to QUOTED; a later rate_config change never reprices it.',
  })
  @ApiOkResponse({ type: QuoteDto })
  quote(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<QuoteDto> {
    return this.campaigns.quote(user.id, id);
  }

  @Post(':id/plan')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview price for a budget or slot count',
    description: 'Stateless budget↔reach preview — solves slots/reach for a budget (or prices a slot count). Persists nothing; use it to drive the slider, then quote to commit.',
  })
  @ApiOkResponse({ type: CampaignPlanDto })
  plan(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PlanRequestDto,
  ): Promise<CampaignPlanDto> {
    return this.campaigns.plan(user.id, id, { budgetMinor: dto.budget_minor, slots: dto.slots });
  }

  @Post(':id/submit')
  @ApiOperation({ summary: 'Submit a quoted campaign for admin approval' })
  @ApiOkResponse({ type: CampaignDto })
  submit(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<CampaignDto> {
    return this.campaigns.submitForApproval(user.id, id);
  }

  @Get(':id/assets')
  @ApiOperation({ summary: 'List campaign assets' })
  @ApiOkResponse()
  listAssets(@CurrentUser() user: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<AssetView[]> {
    return this.assets.list(user.id, id);
  }

  @Post(':id/assets')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload one asset', description: 'A CAPTION asset is text-only; other kinds require a file (≤10 MB).' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        kind: { type: 'string', enum: ['IMAGE', 'VIDEO', 'DOCUMENT', 'POSTER', 'CAPTION', 'LOGO'] },
        caption_text: { type: 'string' },
        order_index: { type: 'integer' },
      },
      required: ['kind'],
    },
  })
  @ApiCreatedResponse()
  uploadAsset(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() meta: AssetMetaDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<AssetView> {
    return this.assets.upload(
      user.id,
      id,
      file ? { buffer: file.buffer, mimetype: file.mimetype, size: file.size } : undefined,
      meta,
    );
  }
}
