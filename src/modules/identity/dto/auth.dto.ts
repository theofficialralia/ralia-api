import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdminCapability, Gender, Role } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** E.164, Nigeria-shaped but not Nigeria-only. */
const E164 = /^\+[1-9]\d{7,14}$/;

export class RegisterDto {
  @ApiProperty({ example: 'ada@example.com' })
  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: '+2348012345678', description: 'E.164, with country code.' })
  @IsString()
  @Matches(E164, { message: 'phone_e164 must be E.164, e.g. +2348012345678' })
  phone_e164!: string;

  @ApiProperty({ example: 'correct horse battery staple', minLength: 10 })
  @IsString()
  // Length beats composition rules for real-world strength, and this audience is
  // typing on phones.
  @MinLength(10)
  @MaxLength(200)
  password!: string;

  @ApiProperty({ enum: [Role.CLIENT, Role.PROMOTER], example: Role.PROMOTER })
  @IsEnum(Role, { message: 'role must be CLIENT or PROMOTER' })
  role!: Extract<Role, 'CLIENT' | 'PROMOTER'>;

  @ApiProperty({ required: false, example: 'Naija Threads', description: 'Required when role is CLIENT.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  org_name?: string;

  // ── Promoter profile (optional; captured on the promoter signup form) ──
  @ApiPropertyOptional({ example: 'Chidera Okoye', description: 'Promoter full name.' })
  @IsOptional() @IsString() @MaxLength(120) @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  full_name?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional() @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional({ example: '1998-04-12', description: 'ISO date (YYYY-MM-DD).' })
  @IsOptional() @IsDateString()
  date_of_birth?: string;

  @ApiPropertyOptional({ example: 'Nigeria' })
  @IsOptional() @IsString() @MaxLength(60)
  country?: string;

  @ApiPropertyOptional({ example: 'Lagos' })
  @IsOptional() @IsString() @MaxLength(60)
  state?: string;

  @ApiPropertyOptional({ example: 'Ikeja' })
  @IsOptional() @IsString() @MaxLength(80)
  lga?: string;

  @ApiProperty({ example: true, description: 'Must be true. Recorded as a consent row.' })
  @IsBoolean()
  accepted_terms!: boolean;

  @ApiProperty({ example: true, description: 'Must be true. Recorded as a consent row.' })
  @IsBoolean()
  accepted_privacy!: boolean;
}

export class LoginDto {
  @ApiProperty({ example: 'ada@example.com' })
  @IsEmail()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  email!: string;

  @ApiProperty({ example: 'correct horse battery staple' })
  @IsString()
  @MaxLength(200)
  password!: string;
}

export class GoogleSignInDto {
  @ApiProperty({ description: 'The Google ID token (JWT) from Google Identity Services.' })
  @IsString()
  @MaxLength(4096)
  id_token!: string;

  @ApiProperty({ enum: ['CLIENT', 'PROMOTER'], description: 'Which kind of account to create on first sign-in.' })
  @IsEnum(Role, { message: 'role must be CLIENT or PROMOTER' })
  role!: Extract<Role, 'CLIENT' | 'PROMOTER'>;
}

export class OtpRequestDto {
  @ApiProperty({ example: '+2348012345678' })
  @IsString()
  @Matches(E164)
  phone_e164!: string;
}

export class OtpVerifyDto {
  @ApiProperty({ example: '+2348012345678' })
  @IsString()
  @Matches(E164)
  phone_e164!: string;

  @ApiProperty({ example: '123456', minLength: 6, maxLength: 6 })
  @IsString()
  @Length(6, 6)
  code!: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  refresh_token!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  current_password!: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  new_password!: string;
}

// ── Responses ────────────────────────────────────────────────

export class RegisterResponseDto {
  @ApiProperty({ format: 'uuid' })
  user_id!: string;

  @ApiProperty({ example: 'PENDING' })
  status!: string;

  @ApiProperty({
    example: 'VERIFY_PHONE',
    description: 'What the client should do next.',
  })
  next!: string;
}

export class TokenPairDto {
  @ApiProperty()
  access_token!: string;

  @ApiProperty()
  refresh_token!: string;

  @ApiProperty({ example: 900, description: 'Access token lifetime in seconds.' })
  expires_in!: number;

  @ApiProperty({ example: 'Bearer' })
  token_type!: string;
}

export class MeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  phone_e164!: string;

  @ApiProperty({ enum: Role, isArray: true })
  roles!: Role[];

  @ApiProperty({ enum: AdminCapability, isArray: true, description: 'Admin capabilities, flattened across roles.' })
  capabilities!: AdminCapability[];

  @ApiProperty()
  status!: string;

  @ApiProperty({ nullable: true })
  phone_verified_at!: Date | null;
}

export class AcceptedDto {
  @ApiProperty({ example: true })
  accepted!: boolean;

  @ApiProperty({ example: 'If that number is registered, a code has been sent.' })
  message!: string;
}
