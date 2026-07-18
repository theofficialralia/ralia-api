import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { AdminCapability, Role } from '@prisma/client';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthedUser } from '../../common/auth/jwt-auth.guard';
import { RequiresCapability, Roles } from '../../common/auth/roles.guard';
import { RequiresIdempotencyKey } from '../../common/idempotency/idempotency.guard';
import { AdminService } from './admin.service';
import { AdminDecisionDto, FundCampaignDto, RecordWithdrawalPaidDto, RejectDto } from './dto/admin.dto';

/**
 * Admin console API.
 *
 * The two capabilities are enforced per-endpoint, not per-role: reviewing
 * evidence and recording money are separable even though one person holds both
 * at launch (§7). Splitting them later is a refactor; splitting them now is free.
 */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Roles(Role.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ── Queues ───────────────────────────────────────────────

  @Get('queues/promoters')
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Promoters awaiting approval' })
  pendingPromoters() {
    return this.admin.pendingPromoters();
  }

  @Get('queues/campaigns')
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Campaigns awaiting approval or payment' })
  pendingCampaigns() {
    return this.admin.pendingCampaigns();
  }

  @Get('queues/submissions')
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Submissions awaiting review', description: 'auto_flag marks perceptual duplicates.' })
  pendingSubmissions() {
    return this.admin.pendingSubmissions();
  }

  @Get('queues/withdrawals')
  @RequiresCapability(AdminCapability.RECORD_MONEY)
  @ApiOperation({ summary: 'Withdrawals awaiting approval or payment' })
  pendingWithdrawals() {
    return this.admin.pendingWithdrawals();
  }

  // ── People ───────────────────────────────────────────────

  @Post('promoters/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Approve a promoter', description: 'Also activates their channels so they become matchable.' })
  @ApiOkResponse({ type: AdminDecisionDto })
  approvePromoter(@CurrentUser() admin: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<AdminDecisionDto> {
    return this.admin.approvePromoter(admin.id, id);
  }

  @Post('promoters/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Reject a promoter (reason required)' })
  @ApiOkResponse({ type: AdminDecisionDto })
  rejectPromoter(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectDto,
  ): Promise<AdminDecisionDto> {
    return this.admin.rejectPromoter(admin.id, id, dto.reason);
  }

  // ── Campaigns ────────────────────────────────────────────

  @Post('campaigns/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Approve a campaign', description: 'Moves it to CONFIRMING_PAYMENT; funding makes it LIVE.' })
  @ApiOkResponse({ type: AdminDecisionDto })
  approveCampaign(@CurrentUser() admin: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<AdminDecisionDto> {
    return this.admin.approveCampaign(admin.id, id);
  }

  @Post('campaigns/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Reject a campaign (reason required)' })
  @ApiOkResponse({ type: AdminDecisionDto })
  rejectCampaign(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectDto,
  ): Promise<AdminDecisionDto> {
    return this.admin.rejectCampaign(admin.id, id, dto.reason);
  }

  @Post('campaigns/:id/fund')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.RECORD_MONEY)
  @RequiresIdempotencyKey()
  @ApiOperation({
    summary: 'Record the client’s bank transfer',
    description: 'DR BANK_CLEARING / CR CAMPAIGN_ESCROW, then the campaign goes LIVE. Requires an Idempotency-Key.',
  })
  @ApiOkResponse({ type: AdminDecisionDto })
  fundCampaign(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FundCampaignDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ): Promise<AdminDecisionDto> {
    return this.admin.fundCampaign(admin.id, id, BigInt(dto.amount_minor), idempotencyKey, dto.reference);
  }

  // ── Submissions ──────────────────────────────────────────

  @Post('submissions/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @RequiresIdempotencyKey()
  @ApiOperation({
    summary: 'Approve proof and pay the promoter',
    description: 'Fee to the promoter and Ralia’s take leave escrow in one balanced transaction. Requires an Idempotency-Key.',
  })
  @ApiOkResponse({ type: AdminDecisionDto })
  approveSubmission(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string,
  ): Promise<AdminDecisionDto> {
    return this.admin.approveSubmission(admin.id, id, idempotencyKey);
  }

  @Post('submissions/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Reject proof (reason required)', description: 'The assignment returns to REJECTED so the promoter can resubmit.' })
  @ApiOkResponse({ type: AdminDecisionDto })
  rejectSubmission(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectDto,
  ): Promise<AdminDecisionDto> {
    return this.admin.rejectSubmission(admin.id, id, dto.reason);
  }

  // ── Withdrawals ──────────────────────────────────────────

  @Post('withdrawals/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.RECORD_MONEY)
  @ApiOperation({ summary: 'Approve a withdrawal request' })
  @ApiOkResponse({ type: AdminDecisionDto })
  approveWithdrawal(@CurrentUser() admin: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<AdminDecisionDto> {
    return this.admin.approveWithdrawal(admin.id, id);
  }

  @Post('withdrawals/:id/record-paid')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.RECORD_MONEY)
  @RequiresIdempotencyKey()
  @ApiOperation({
    summary: 'Record the payout transfer you sent',
    description: 'DR PROMOTER_AVAILABLE / CR BANK_CLEARING. Requires an Idempotency-Key.',
  })
  @ApiOkResponse({ type: AdminDecisionDto })
  recordWithdrawalPaid(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordWithdrawalPaidDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ): Promise<AdminDecisionDto> {
    return this.admin.recordWithdrawalPaid(admin.id, id, dto.paid_ref, idempotencyKey);
  }
}
