import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class SendOffersDto {
  @ApiProperty({ type: [String], format: 'uuid', description: 'Promoter ids from the candidates list.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  promoter_ids!: string[];
}

export class CandidateChannelDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  platform!: string;

  @ApiProperty()
  effective_reach!: number;
}

export class CandidateDto {
  @ApiProperty({ format: 'uuid' })
  promoter_id!: string;

  @ApiProperty({ nullable: true })
  full_name!: string | null;

  @ApiProperty({ nullable: true })
  location_state!: string | null;

  @ApiProperty()
  trust_score!: number;

  @ApiProperty({ type: CandidateChannelDto })
  channel!: CandidateChannelDto;

  @ApiProperty()
  assignments_this_week!: number;

  @ApiProperty()
  max_campaigns_per_week!: number;
}

export class OfferDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  campaign_id!: string;

  @ApiProperty()
  campaign_name!: string;

  @ApiProperty()
  role!: string;

  @ApiProperty({ example: 2415, description: 'What the promoter earns, in kobo.' })
  fee_minor!: number;

  @ApiProperty({ format: 'date-time' })
  expires_at!: string;

  @ApiProperty()
  status!: string;
}

export class AssignmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  campaign_id!: string;

  @ApiProperty()
  role!: string;

  @ApiProperty({ example: 2415 })
  fee_minor!: number;

  @ApiProperty({ description: 'The token behind this assignment’s tracking link.' })
  tracking_token!: string;

  @ApiProperty()
  status!: string;
}
