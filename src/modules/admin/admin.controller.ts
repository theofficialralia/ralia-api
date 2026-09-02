import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { AdminCapability, ClientOrgStatus, Role } from '@prisma/client';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthedUser } from '../../common/auth/jwt-auth.guard';
import { RequiresCapability, Roles } from '../../common/auth/roles.guard';
import { RequiresIdempotencyKey } from '../../common/idempotency/idempotency.guard';
import { AdminService } from './admin.service';
import { AdminDecisionDto, ApproveSubmissionDto, ExposureReportDto, FundCampaignDto, RateConfigUpdateDto, ReconciliationReportDto, RecordWithdrawalPaidDto, RejectDto, SetCapabilityDto, SetKycDto, SettleGatewayPaymentDto, VerifyChannelDto } from './dto/admin.dto';

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

  @Get('promoters')
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'All promoters (directory, any status)' })
  allPromoters() {
    return this.admin.allPromoters();
  }

  @Get('promoters/:id')
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'One promoter in full (channels + capability, any status)' })
  promoterDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.promoterDetail(id);
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

  @Post('promoters/:id/capability')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Override a promoter’s per-role capability (§3)', description: 'Merges the given 0–100 scores over the computed ones and records the confirmation.' })
  @ApiOkResponse({ type: AdminDecisionDto })
  setCapability(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetCapabilityDto,
  ): Promise<AdminDecisionDto> {
    return this.admin.setCapability(admin.id, id, dto.scores);
  }

  @Post('promoters/:id/kyc')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Set a promoter’s KYC state (§10)', description: 'Gates cash-out — a payout can only be approved once KYC is VERIFIED.' })
  @ApiOkResponse({ type: AdminDecisionDto })
  setKyc(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetKycDto,
  ): Promise<AdminDecisionDto> {
    return this.admin.setKyc(admin.id, id, dto.status);
  }

  // ── Campaigns ────────────────────────────────────────────

  @Get('live-campaigns')
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Live/paused campaigns', description: 'The campaigns an admin can match promoters to.' })
  liveCampaigns() {
    return this.admin.liveCampaigns();
  }

  @Get('campaigns/:id')
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Campaign detail for review', description: 'Client, brief, targeting and assets — for approval and matching context.' })
  campaignDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.campaignDetail(id);
  }

  @Get('campaigns/:id/submissions')
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'All proof for one campaign', description: 'Full submission history (pending, approved, rejected) — powers the campaign Submissions tab.' })
  campaignSubmissions(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.campaignSubmissions(id);
  }

  @Post('campaigns/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Approve a campaign', description: 'Moves it to CONFIRMING_PAYMENT; funding makes it LIVE.' })
  @ApiOkResponse({ type: AdminDecisionDto })
  approveCampaign(@CurrentUser() admin: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<AdminDecisionDto> {
    return this.admin.approveCampaign(admin.id, id);
  }

  @Post('campaigns/:id/allocate')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Run one hybrid allocation pass', description: 'Extends offers to the best-fit candidates (head-start then open free-to-air), over-offering in the open phase. Idempotent.' })
  allocateCampaign(@CurrentUser() admin: AuthedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.allocateCampaign(admin.id, id);
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
    return this.admin.rejectCampaign(admin.id, id, dto.reason, dto.terminal ?? false);
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

  // ── Channels ─────────────────────────────────────────────

  @Post('channels/:id/verify')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({
    summary: 'Verify a channel’s audience evidence',
    description: 'Sets the verification tier (screenshot/insights), stamps verified_at, and recomputes effective reach — lifting the self-reported cap.',
  })
  @ApiOkResponse({ type: AdminDecisionDto })
  verifyChannel(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyChannelDto,
  ): Promise<AdminDecisionDto> {
    return this.admin.verifyChannel(admin.id, id, dto.tier);
  }

  @Post('channels/:id/unverify')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Drop a channel to self-reported (reason required)', description: 'Clears verified_at and re-caps reach when a proof is bad or stale.' })
  @ApiOkResponse({ type: AdminDecisionDto })
  unverifyChannel(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectDto,
  ): Promise<AdminDecisionDto> {
    return this.admin.unverifyChannel(admin.id, id, dto.reason);
  }

  @Post('channels/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Approve a single channel', description: 'Marks the channel ACTIVE. The promoter is activated on their first approved channel and stays reviewable so the rest can still be approved or rejected.' })
  @ApiOkResponse({ type: AdminDecisionDto })
  approveChannel(@CurrentUser() admin: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<AdminDecisionDto> {
    return this.admin.approveChannel(admin.id, id);
  }

  @Post('channels/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Reject a single channel (reason required)', description: 'Marks the channel REJECTED so it is never matched on and its reach drops out of scoring.' })
  @ApiOkResponse({ type: AdminDecisionDto })
  rejectChannel(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectDto,
  ): Promise<AdminDecisionDto> {
    return this.admin.rejectChannel(admin.id, id, dto.reason);
  }

  // ── Submissions ──────────────────────────────────────────

  @Post('submissions/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @RequiresIdempotencyKey()
  @ApiOperation({
    summary: 'Approve proof and settle the promoter pro-rata',
    description: 'Pays the promoter pro-rata on verified_views, takes Ralia’s cut, and refunds the undelivered remainder to the client — all in one balanced transaction. A delivery below the threshold is refused (reject instead). Requires an Idempotency-Key.',
  })
  @ApiOkResponse({ type: AdminDecisionDto })
  approveSubmission(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveSubmissionDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ): Promise<AdminDecisionDto> {
    return this.admin.approveSubmission(admin.id, id, dto.verified_views, idempotencyKey);
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

  @Post('withdrawals/:id/fail')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.RECORD_MONEY)
  @ApiOperation({ summary: 'Fail a not-yet-paid withdrawal (reason required)', description: 'REQUESTED/APPROVED → FAILED. The balance is untouched — nothing was posted yet.' })
  @ApiOkResponse({ type: AdminDecisionDto })
  failWithdrawal(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectDto,
  ): Promise<AdminDecisionDto> {
    return this.admin.failWithdrawal(admin.id, id, dto.reason);
  }

  @Post('withdrawals/:id/reverse')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.RECORD_MONEY)
  @RequiresIdempotencyKey()
  @ApiOperation({ summary: 'Reverse a paid withdrawal that bounced (reason required)', description: 'DR BANK_CLEARING / CR PROMOTER_AVAILABLE — funds return to the promoter’s balance. Requires an Idempotency-Key.' })
  @ApiOkResponse({ type: AdminDecisionDto })
  reverseWithdrawal(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ): Promise<AdminDecisionDto> {
    return this.admin.reverseWithdrawal(admin.id, id, dto.reason, idempotencyKey);
  }

  // ── Gateway reconciliation ───────────────────────────────

  @Get('reconciliation')
  @RequiresCapability(AdminCapability.RECORD_MONEY)
  @ApiOperation({
    summary: 'Reconcile gateway charges against the ledger',
    description: 'Per charge: campaign price vs gateway-reported vs the escrow credit the ledger holds. ledger_matches_gateway is the overall proof.',
  })
  @ApiOkResponse({ type: ReconciliationReportDto })
  reconciliation(): Promise<ReconciliationReportDto> {
    return this.admin.reconciliationReport();
  }

  @Get('finance/exposure')
  @RequiresCapability(AdminCapability.RECORD_MONEY)
  @ApiOperation({
    summary: 'Platform exposure & payout liability (§10)',
    description: 'Money position by account kind + the payout obligation in flight. promoter_payable is fully backed by settled escrow — fully_backed proves it.',
  })
  @ApiOkResponse({ type: ExposureReportDto })
  exposure(): Promise<ExposureReportDto> {
    return this.admin.exposureReport();
  }

  @Post('reconciliation/:id/settle')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.RECORD_MONEY)
  @ApiOperation({
    summary: 'Confirm a gateway settlement cleared',
    description: 'RECORDED → SETTLED, recording the settlement reference and the amount actually settled (net of gateway fees).',
  })
  @ApiOkResponse({ type: AdminDecisionDto })
  settleGatewayPayment(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SettleGatewayPaymentDto,
  ): Promise<AdminDecisionDto> {
    return this.admin.settleGatewayPayment(admin.id, id, dto.settlement_ref, BigInt(dto.settled_minor));
  }

  @Post('reconciliation/:id/flag')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.RECORD_MONEY)
  @ApiOperation({ summary: 'Flag a settlement discrepancy (reason required)', description: '→ MISMATCH for finance to investigate.' })
  @ApiOkResponse({ type: AdminDecisionDto })
  flagGatewayPayment(
    @CurrentUser() admin: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectDto,
  ): Promise<AdminDecisionDto> {
    return this.admin.flagGatewayPayment(admin.id, id, dto.reason);
  }

  // ── Clients ──────────────────────────────────────────────

  @Get('clients')
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'All clients', description: 'Client orgs with campaigns created and amount spent.' })
  clients() {
    return this.admin.clients();
  }

  @Post('clients/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Deactivate a client', description: 'Suspends the client org.' })
  @ApiOkResponse({ type: AdminDecisionDto })
  deactivateClient(@CurrentUser() admin: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<AdminDecisionDto> {
    return this.admin.setClientStatus(admin.id, id, ClientOrgStatus.SUSPENDED);
  }

  @Post('clients/:id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Reactivate a client' })
  @ApiOkResponse({ type: AdminDecisionDto })
  reactivateClient(@CurrentUser() admin: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<AdminDecisionDto> {
    return this.admin.setClientStatus(admin.id, id, ClientOrgStatus.ACTIVE);
  }

  @Post('promoters/:id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Deactivate a promoter', description: 'Excludes them from matching and blocks sign-in, reversibly.' })
  @ApiOkResponse({ type: AdminDecisionDto })
  deactivatePromoter(@CurrentUser() admin: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<AdminDecisionDto> {
    return this.admin.setPromoterStatus(admin.id, id, false);
  }

  @Post('promoters/:id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Reactivate a promoter' })
  @ApiOkResponse({ type: AdminDecisionDto })
  reactivatePromoter(@CurrentUser() admin: AuthedUser, @Param('id', ParseUUIDPipe) id: string): Promise<AdminDecisionDto> {
    return this.admin.setPromoterStatus(admin.id, id, true);
  }

  // ── Settings ─────────────────────────────────────────────

  @Get('rate-config')
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Platform rules', description: 'The tunable coefficients. Changing them never reprices a quoted campaign.' })
  rateConfig() {
    return this.admin.platformRules();
  }

  @Patch('rate-config')
  @RequiresCapability(AdminCapability.RECORD_MONEY)
  @ApiOperation({ summary: 'Update platform rules', description: 'Only the fields sent change. Audited.' })
  updateRateConfig(@CurrentUser() admin: AuthedUser, @Body() dto: RateConfigUpdateDto) {
    return this.admin.updateRateConfig(admin.id, dto);
  }

  @Get('audit-log')
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Audit log', description: 'Recent money- and score-affecting writes, attributed to the admin.' })
  auditLog() {
    return this.admin.auditLog();
  }

  @Get('team')
  @ApiOperation({ summary: 'Admin team', description: 'Admins, their capabilities, and pending invites. Any admin may view; managing needs MANAGE_TEAM.' })
  team() {
    return this.admin.team();
  }

  // ── Analytics ────────────────────────────────────────────

  @Get('analytics')
  @RequiresCapability(AdminCapability.REVIEW_EVIDENCE)
  @ApiOperation({ summary: 'Platform analytics', description: 'GMV, revenue, active counts and status breakdowns.' })
  analytics() {
    return this.admin.analytics();
  }
}
