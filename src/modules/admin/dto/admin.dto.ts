import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReconciliationStatus, VerificationTier } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsPositive, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { MoneyDto } from '../../ledger/money';

/** Rejecting anything requires a reason (§6). */
export class RejectDto {
  @ApiProperty({ example: 'Screenshot does not show the campaign creative.' })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  reason!: string;
}

/** Verifying a channel's audience evidence sets a proven tier (§1). */
export class VerifyChannelDto {
  @ApiProperty({
    enum: [VerificationTier.SCREENSHOT, VerificationTier.INSIGHTS],
    example: VerificationTier.SCREENSHOT,
    description: 'The tier the evidence supports. SELF is not a verification — use unverify to drop a channel back.',
  })
  @IsIn([VerificationTier.SCREENSHOT, VerificationTier.INSIGHTS])
  tier!: VerificationTier;
}

/** Approving proof settles it pro-rata on the verified delivered views (§2). */
export class ApproveSubmissionDto {
  @ApiProperty({ example: 842, description: 'Admin-verified delivered effective views. Drives pro-rata pay; below the delivery threshold, approval is refused.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  verified_views!: number;
}

export class FundCampaignDto {
  @ApiProperty({ example: 34500, description: 'Amount received, in kobo. Must equal the campaign price.' })
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  amount_minor!: number;

  @ApiPropertyOptional({ example: 'GTB transfer ref 8837261', description: 'Bank reference for the transfer received.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;
}

export class RecordWithdrawalPaidDto {
  @ApiProperty({ example: 'Zenith transfer ref 552117', description: 'Reference of the transfer the admin sent.' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  paid_ref!: string;
}

export class RequestWithdrawalDto {
  @ApiProperty({ example: 500000, description: 'Amount to withdraw, in kobo.' })
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  amount_minor!: number;
}

// ── Responses ────────────────────────────────────────────────

export class WalletDto {
  @ApiProperty({ type: MoneyDto, description: 'Derived from ledger postings — there is no balance column.' })
  available!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'Requested or approved but not yet paid.' })
  pending_withdrawal!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'Minimum a withdrawal may be.' })
  withdrawal_minimum!: MoneyDto;

  @ApiProperty({ example: true, description: 'False when the balance is below the minimum.' })
  can_withdraw!: boolean;
}

export class WithdrawalDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: MoneyDto })
  amount!: MoneyDto;

  @ApiProperty({ example: 'REQUESTED' })
  status!: string;

  @ApiProperty({ nullable: true })
  paid_ref!: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at!: string;
}

export class AdminDecisionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty({ example: 'Recorded.', description: 'What changed.' })
  message!: string;
}

/** One gateway charge, with the ledger amount it should reconcile to (§10). */
export class GatewayPaymentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  campaign_id!: string;

  @ApiProperty({ example: 'RLA-9F2K-84B' })
  reference!: string;

  @ApiProperty({ type: MoneyDto, description: 'The campaign price the charge was for.' })
  expected!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'What the gateway reported at verify time.' })
  gateway!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'The escrow credit the ledger actually holds for this reference.' })
  ledger!: MoneyDto;

  @ApiProperty({ example: true, description: 'Whether the ledger credit equals the gateway amount.' })
  matched!: boolean;

  @ApiProperty({ enum: ReconciliationStatus })
  status!: ReconciliationStatus;

  @ApiProperty({ type: MoneyDto, nullable: true, description: 'Amount confirmed settled, once reconciled.' })
  settled!: MoneyDto | null;

  @ApiProperty({ nullable: true })
  settlement_ref!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  settled_at!: string | null;
}

/** Ledger-vs-gateway reconciliation across every gateway charge (§10). */
export class ReconciliationReportDto {
  @ApiProperty({ type: MoneyDto, description: 'Total the gateway reported across all charges.' })
  gateway_total!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'Total confirmed settled.' })
  settled_total!: MoneyDto;

  @ApiProperty({ example: true, description: 'True when every ledger escrow credit equals its gateway amount.' })
  ledger_matches_gateway!: boolean;

  @ApiProperty({ example: 3, description: 'Charges awaiting settlement confirmation.' })
  recorded!: number;

  @ApiProperty({ example: 10 })
  settled!: number;

  @ApiProperty({ example: 0 })
  mismatched!: number;

  @ApiProperty({ type: [GatewayPaymentDto] })
  payments!: GatewayPaymentDto[];
}

/** Confirming a gateway settlement cleared (§10). */
export class SettleGatewayPaymentDto {
  @ApiProperty({ example: 'PSTK_STL_20260803', description: 'The gateway settlement batch reference.' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  settlement_ref!: string;

  @ApiProperty({ example: 261000, description: 'Amount actually settled, in kobo (net of gateway fees).' })
  @IsInt()
  @IsPositive()
  settled_minor!: number;
}

/** Editable platform knobs (§ ALGORITHMS). All optional — only sent fields change. */
export class RateConfigUpdateDto {
  @ApiPropertyOptional({ example: 3000, description: 'RPM — kobo per 1,000 effective views.' })
  @IsOptional() @IsInt() @Min(0)
  rpm_minor?: number;

  @ApiPropertyOptional({ example: 30, description: 'Ralia take rate, whole percent.' })
  @IsOptional() @IsInt() @Min(0) @Max(90)
  take_rate_pct?: number;

  @ApiPropertyOptional({ example: 70, description: 'Delivery threshold τ, whole percent of promised.' })
  @IsOptional() @IsInt() @Min(1) @Max(100)
  delivery_threshold_pct?: number;

  @ApiPropertyOptional({ example: 2000, description: 'Self-reported effective-reach cap.' })
  @IsOptional() @IsInt() @Min(0)
  unverified_reach_cap?: number;

  @ApiPropertyOptional({ example: 90, description: 'Proof validity window, days.' })
  @IsOptional() @IsInt() @Min(1)
  proof_validity_days?: number;

  @ApiPropertyOptional({ example: 30, description: 'Minimum trust score to be matched.' })
  @IsOptional() @IsInt() @Min(0) @Max(100)
  min_trust_score?: number;

  @ApiPropertyOptional({ example: 24, description: 'Offer accept window, hours.' })
  @IsOptional() @IsInt() @Min(1)
  offer_expiry_hours?: number;

  @ApiPropertyOptional({ example: 500000, description: 'Minimum withdrawal, kobo.' })
  @IsOptional() @IsInt() @Min(0)
  withdrawal_minimum_minor?: number;
}
