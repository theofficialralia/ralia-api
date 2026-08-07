import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** One social channel the business is present on. */
export class ClientSocialDto {
  @ApiProperty({ example: 'INSTAGRAM', description: 'Platform key (e.g. WHATSAPP, INSTAGRAM, X, TIKTOK, FACEBOOK).' })
  @IsString() @MaxLength(30) @Transform(trim)
  platform!: string;

  @ApiPropertyOptional({ example: 'instagram.com/skinsmith' })
  @IsOptional() @IsString() @MaxLength(200) @Transform(trim)
  url?: string;

  @ApiPropertyOptional({ example: 4200 })
  @IsOptional() @IsInt() @Min(0)
  followers?: number;
}

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

  @ApiPropertyOptional({ type: [ClientSocialDto], description: 'Social channels the business is on.' })
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => ClientSocialDto)
  socials?: ClientSocialDto[];
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

  @ApiProperty({ type: [ClientSocialDto], nullable: true })
  socials!: ClientSocialDto[] | null;

  @ApiProperty({ example: 'ACTIVE' })
  status!: string;
}
