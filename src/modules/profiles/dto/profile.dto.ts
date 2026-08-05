import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender, Platform, PromoterRole, PromoterStatus, VerificationTier } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

// ── Profile ──────────────────────────────────────────────────

/**
 * Every field optional: the questionnaire saves partially and resumes.
 *
 * `age` and `trust_score` are absent by design. Age is derived from dob, and
 * trust_score is not the promoter's to set.
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Ada Okafor' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  full_name?: string;

  @ApiPropertyOptional({ example: '1998-04-12', description: 'ISO date. Requires DATA_DOB consent, recorded on save.' })
  @IsOptional()
  @IsDateString()
  dob?: string;

  @ApiPropertyOptional({ enum: Gender, description: 'Requires DATA_GENDER consent, recorded on save.' })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional({ example: 'Lagos' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  location_state?: string;

  @ApiPropertyOptional({ example: ['English', 'Yoruba'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  languages_spoken?: string[];

  @ApiPropertyOptional({ example: ['Fashion', 'Tech'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  preferred_categories?: string[];

  @ApiPropertyOptional({ example: 3, minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  max_campaigns_per_week?: number;

  @ApiPropertyOptional({ enum: PromoterRole, isArray: true, description: 'The roles this promoter offers.' })
  @IsOptional()
  @IsArray()
  @IsEnum(PromoterRole, { each: true })
  @ArrayMaxSize(4)
  roles?: PromoterRole[];

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'number' }, description: 'Self-reported capability factors, each normalised 0–1.' })
  @IsOptional()
  @IsObject()
  capability_inputs?: Record<string, number>;
}

export class ProfileDto {
  @ApiProperty({ format: 'uuid' })
  user_id!: string;

  @ApiProperty({ enum: PromoterStatus })
  status!: PromoterStatus;

  @ApiProperty({ nullable: true })
  full_name!: string | null;

  @ApiProperty({ nullable: true, example: '1998-04-12' })
  dob!: string | null;

  @ApiProperty({ nullable: true, description: 'Derived from dob. Never client-set.' })
  age!: number | null;

  @ApiProperty({ enum: Gender, nullable: true })
  gender!: Gender | null;

  @ApiProperty({ nullable: true })
  location_state!: string | null;

  @ApiProperty({ type: [String] })
  languages_spoken!: string[];

  @ApiProperty({ type: [String] })
  preferred_categories!: string[];

  @ApiProperty()
  max_campaigns_per_week!: number;

  @ApiProperty({ example: 50, description: 'Set by admins, not by the promoter.' })
  trust_score!: number;

  @ApiProperty({ enum: PromoterRole, isArray: true, description: 'Roles this promoter offers.' })
  roles!: PromoterRole[];

  @ApiProperty({ nullable: true, type: 'object', additionalProperties: { type: 'number' }, description: 'Self-reported capability factors (0–1).' })
  capability_inputs!: Record<string, number> | null;

  @ApiProperty({ nullable: true, type: 'object', additionalProperties: { type: 'number' }, description: 'Admin-confirmed per-role capability (0–100).' })
  capability_scores!: Record<string, number> | null;

  @ApiProperty({ example: false, description: 'True once every required field is present and at least one channel exists.' })
  complete!: boolean;

  @ApiProperty({ type: [String], example: ['location_state'], description: 'What is still outstanding.' })
  missing!: string[];
}

// ── Channels ─────────────────────────────────────────────────

/**
 * `verification_tier` and `effective_reach` are absent by design. A client that
 * could set its own tier could multiply its own reach by 1.15; a client that
 * could set effective_reach could name its own price.
 */
export class CreateChannelDto {
  @ApiProperty({ enum: Platform })
  @IsEnum(Platform)
  platform!: Platform;

  @ApiPropertyOptional({ example: '@adastyles' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  handle?: string;

  @ApiPropertyOptional({ example: 'https://instagram.com/adastyles' })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(400)
  url?: string;

  @ApiProperty({ example: 2400, minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  @Type(() => Number)
  claimed_audience!: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  is_group?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  is_group_admin?: boolean;

  @ApiPropertyOptional({ example: 500 })
  @IsOptional()
  @IsInt()
  @Min(0)
  group_members?: number;

  @ApiPropertyOptional({ example: 120 })
  @IsOptional()
  @IsInt()
  @Min(0)
  active_participants?: number;
}

export class ChannelDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: Platform })
  platform!: Platform;

  @ApiProperty({ nullable: true })
  handle!: string | null;

  @ApiProperty({ nullable: true })
  url!: string | null;

  @ApiProperty({ example: 2400 })
  claimed_audience!: number;

  @ApiProperty({ enum: VerificationTier, description: 'SELF until an admin verifies evidence.' })
  verification_tier!: VerificationTier;

  @ApiProperty({ example: 144, description: 'claimed × platform factor × verification factor (§5.1). Computed server-side.' })
  effective_reach!: number;

  @ApiProperty()
  status!: string;

  @ApiProperty({ example: false })
  admin_frozen!: boolean;
}

// ── Bank ─────────────────────────────────────────────────────

export class CreateBankAccountDto {
  @ApiProperty({ example: '058', description: 'Nigerian bank code.' })
  @IsString()
  @Matches(/^\d{3,6}$/, { message: 'bank_code must be 3-6 digits' })
  bank_code!: string;

  @ApiProperty({ example: '0123456789', description: 'NUBAN, 10 digits. Encrypted at rest; never returned.' })
  @IsString()
  @Matches(/^\d{10}$/, { message: 'account_number must be a 10-digit NUBAN' })
  account_number!: string;

  @ApiProperty({ example: 'ADA OKAFOR' })
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  account_name!: string;
}

export class BankAccountDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '058' })
  bank_code!: string;

  @ApiProperty({ example: '******6789', description: 'Masked. The full number is never returned.' })
  account_number_masked!: string;

  @ApiProperty({ example: 'ADA OKAFOR' })
  account_name!: string;

  @ApiProperty({ example: true })
  is_default!: boolean;
}
