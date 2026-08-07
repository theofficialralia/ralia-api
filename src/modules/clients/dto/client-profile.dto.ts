import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateClientProfileDto {
  @ApiPropertyOptional({ example: 'Skinsmith Ltd' })
  @IsOptional() @IsString() @MaxLength(120) @Transform(trim)
  name?: string;

  @ApiPropertyOptional({ example: 'Food & Drink' })
  @IsOptional() @IsString() @MaxLength(80) @Transform(trim)
  industry?: string;

  @ApiPropertyOptional({ example: '+2348035550192' })
  @IsOptional() @IsString() @Matches(/^\+?[0-9 ]{7,20}$/, { message: 'Enter a valid phone number' })
  phone_whatsapp?: string;

  @ApiPropertyOptional({ example: 'instagram.com/skinsmith' })
  @IsOptional() @IsString() @MaxLength(200) @Transform(trim)
  website?: string;

  @ApiPropertyOptional({ example: 'Street, city, state' })
  @IsOptional() @IsString() @MaxLength(300) @Transform(trim)
  address?: string;

  @ApiPropertyOptional({ example: 'RC 1234567' })
  @IsOptional() @IsString() @MaxLength(60) @Transform(trim)
  cac_number?: string;

  @ApiPropertyOptional({ example: 'David Blake' })
  @IsOptional() @IsString() @MaxLength(120) @Transform(trim)
  support_contact_name?: string;

  @ApiPropertyOptional({ example: '+2348035550192' })
  @IsOptional() @IsString() @MaxLength(30) @Transform(trim)
  support_contact_phone?: string;

  @ApiPropertyOptional({ example: 'A couple of sentences about what you do.' })
  @IsOptional() @IsString() @MaxLength(1000) @Transform(trim)
  description?: string;

  @ApiPropertyOptional({ example: 'INSTAGRAM', description: 'Primary social platform (Platform enum value).' })
  @IsOptional() @IsString() @MaxLength(30) @Transform(trim)
  social_platform?: string;

  @ApiPropertyOptional({ example: 'instagram.com/skinsmith' })
  @IsOptional() @IsString() @MaxLength(200) @Transform(trim)
  social_url?: string;

  @ApiPropertyOptional({ example: 4200, description: 'Follower/subscriber count on the primary social.' })
  @IsOptional() @IsInt() @Min(0)
  social_followers?: number;
}

export class ClientProfileDto {
  @ApiProperty({ format: 'uuid' })
  org_id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ description: 'The account login email. Read-only here — changing it needs re-verification.' })
  email!: string;

  @ApiProperty({ nullable: true })
  industry!: string | null;

  @ApiProperty({ nullable: true })
  phone_whatsapp!: string | null;

  @ApiProperty({ nullable: true })
  website!: string | null;

  @ApiProperty({ nullable: true })
  address!: string | null;

  @ApiProperty({ nullable: true })
  cac_number!: string | null;

  @ApiProperty({ nullable: true })
  support_contact_name!: string | null;

  @ApiProperty({ nullable: true })
  support_contact_phone!: string | null;

  @ApiProperty({ nullable: true })
  description!: string | null;

  @ApiProperty({ nullable: true })
  social_platform!: string | null;

  @ApiProperty({ nullable: true })
  social_url!: string | null;

  @ApiProperty({ nullable: true })
  social_followers!: number | null;

  @ApiProperty({ example: 'ACTIVE' })
  status!: string;
}
