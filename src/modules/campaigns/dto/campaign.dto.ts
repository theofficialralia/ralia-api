import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssetKind, CampaignObjective, CampaignStatus, PromoterRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MoneyDto } from '../../ledger/money';

// ── Create / edit ────────────────────────────────────────────

export class CreateCampaignDto {
  @ApiProperty({ example: 'Harmattan Drop' })
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name!: string;

  @ApiProperty({ enum: CampaignObjective })
  @IsEnum(CampaignObjective)
  objective!: CampaignObjective;

  @ApiPropertyOptional({ example: 'Drive awareness for our new collection.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ example: 'Post the supplied image to your status for 24h.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  promoter_instructions?: string;

  @ApiProperty({ example: 'https://naijathreads.example/shop' })
  @IsUrl({ require_protocol: true })
  @MaxLength(400)
  destination_url!: string;

  @ApiProperty({ example: 12, minimum: 1, maximum: 500, description: 'How many promoter slots.' })
  @IsInt()
  @Min(1)
  @Max(500)
  slots_total!: number;
}

export class UpdateCampaignDto {
  @ApiPropertyOptional({ example: 'Harmattan Drop' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @ApiPropertyOptional({ enum: CampaignObjective })
  @IsOptional()
  @IsEnum(CampaignObjective)
  objective?: CampaignObjective;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  promoter_instructions?: string;

  @ApiPropertyOptional({ example: 'https://naijathreads.example/shop' })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(400)
  destination_url?: string;

  @ApiPropertyOptional({ example: 12, minimum: 1, maximum: 500 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  slots_total?: number;
}

// ── Targeting ────────────────────────────────────────────────

export class SetTargetingDto {
  @ApiPropertyOptional({ type: [String], example: ['Lagos', 'Oyo'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(37)
  states?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(200)
  lgas?: string[];

  @ApiPropertyOptional({ example: 18, minimum: 13, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(13)
  @Max(100)
  age_min?: number;

  @ApiPropertyOptional({ example: 45, minimum: 13, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(13)
  @Max(100)
  age_max?: number;

  @ApiPropertyOptional({ type: [String], example: ['MALE', 'FEMALE'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  genders?: string[];

  @ApiPropertyOptional({ type: [String], example: ['English', 'Yoruba'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  languages?: string[];

  @ApiPropertyOptional({ type: [String], example: ['Fashion'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  categories?: string[];

  @ApiPropertyOptional({ type: [String], enum: ['WHATSAPP_STATUS', 'INSTAGRAM', 'X', 'TIKTOK', 'FACEBOOK', 'TELEGRAM', 'LINKEDIN', 'WHATSAPP_GROUP', 'OFFLINE'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  platforms?: string[];

  @ApiPropertyOptional({ example: 100, minimum: 0, description: 'Minimum effective reach per channel.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  min_effective_reach?: number;

  @ApiPropertyOptional({ type: [String], enum: PromoterRole, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(PromoterRole, { each: true })
  roles?: string[];
}

// ── Assets ───────────────────────────────────────────────────

export class AssetMetaDto {
  @ApiProperty({ enum: AssetKind })
  @IsEnum(AssetKind)
  kind!: AssetKind;

  @ApiPropertyOptional({ example: 'Shop the collection — link in bio.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  caption_text?: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  order_index?: number;
}

// ── Responses ────────────────────────────────────────────────

export class CampaignDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: CampaignObjective })
  objective!: CampaignObjective;

  @ApiProperty({ enum: CampaignStatus })
  status!: CampaignStatus;

  @ApiProperty({ nullable: true })
  description!: string | null;

  @ApiProperty({ nullable: true })
  promoter_instructions!: string | null;

  @ApiProperty()
  destination_url!: string | null;

  @ApiProperty()
  slots_total!: number;

  @ApiProperty()
  slots_filled!: number;

  @ApiPropertyOptional({ description: 'Human clicks delivered — present on the single-campaign detail.' })
  total_clicks?: number;

  @ApiProperty({ type: MoneyDto, nullable: true, description: 'The price quoted, frozen at quote time.' })
  price!: MoneyDto | null;

  @ApiProperty({ type: MoneyDto })
  budget!: MoneyDto;

  @ApiProperty({ nullable: true, format: 'date-time' })
  quoted_at!: string | null;
}

/** Drive a stateless quote preview by a budget or a slot count (budget wins if both given). */
export class PlanRequestDto {
  @ApiPropertyOptional({ example: 500000, description: 'Budget in kobo — solves for how many slots it buys.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  budget_minor?: number;

  @ApiPropertyOptional({ example: 12, description: 'Slot count — prices that many slots directly.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  slots?: number;
}

/** Read-only pricing preview for the budget↔reach slider — persists nothing. */
export class CampaignPlanDto {
  @ApiProperty({ type: MoneyDto, description: 'Per-slot price at current targeting.' })
  unit_price!: MoneyDto;

  @ApiProperty({ example: 12, description: 'Slots this plan buys.' })
  slots!: number;

  @ApiProperty({ type: MoneyDto, description: 'Total price = unit_price × slots.' })
  total_price!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'What one promoter earns per slot.' })
  promoter_fee!: MoneyDto;

  @ApiProperty({ example: 2000, description: 'Per-slot reach basis (targeting.min_effective_reach).' })
  reach_per_slot!: number;

  @ApiProperty({ example: 24000, description: 'Estimated total reach = slots × reach_per_slot.' })
  estimated_total_reach!: number;

  @ApiProperty({ enum: ['DISTRIBUTION', 'CREATION'], description: "The campaign's pricing category, derived from its targeted role." })
  category!: string;

  @ApiProperty({ type: MoneyDto, description: 'Minimum campaign fee for this category — the slider floor.' })
  floor_minor!: MoneyDto;

  @ApiProperty({ example: 5, description: 'Fewest slots that meet the category floor at the current unit price.' })
  min_slots!: number;

  @ApiProperty({ example: false, description: 'Whether this plan meets the category floor (total ≥ floor).' })
  meets_floor!: boolean;

  @ApiProperty({ example: 1000, description: 'Category default reach per slot the wizard pre-fills.' })
  default_reach_per_slot!: number;

  @ApiProperty({ example: 5, description: 'Category default promoter count the wizard pre-fills.' })
  default_promoters!: number;
}

export class QuoteDto {
  @ApiProperty({ type: MoneyDto, description: 'Total campaign price = Σ slot prices.' })
  price!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'Per-slot price at current targeting.' })
  unit_price!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'What one promoter earns per slot (price − take).' })
  promoter_fee!: MoneyDto;

  @ApiProperty({ example: 12 })
  slots_total!: number;

  @ApiProperty({ example: 2400, description: 'Sum of effective reach across eligible promoters (estimate).' })
  estimated_reach!: number;

  @ApiProperty({ example: 34, description: 'How many promoters currently match the targeting.' })
  eligible_promoters!: number;

  @ApiProperty({ example: 3, description: 'Active targeting filters feeding the multiplier.' })
  active_filters!: number;
}
