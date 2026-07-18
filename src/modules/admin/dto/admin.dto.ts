import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, IsString, MaxLength, MinLength } from 'class-validator';
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
