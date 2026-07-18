import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Verdict } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateSubmissionDto {
  @ApiPropertyOptional({
    example: 'https://instagram.com/p/abc123',
    description: 'Optional — a WhatsApp status has no public URL.',
  })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(400)
  public_url?: string;

  @ApiPropertyOptional({ example: 'Posted at 9am, left up 24h.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  note?: string;
}

export class SubmissionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  assignment_id!: string;

  @ApiProperty({ enum: Verdict, description: 'Always PENDING on creation — nothing auto-approves.' })
  verdict!: Verdict;

  @ApiProperty({
    example: false,
    description: 'True when the screenshot perceptually matches an existing one. A flag for the admin, not a rejection.',
  })
  auto_flag!: boolean;

  @ApiProperty({ nullable: true })
  public_url!: string | null;

  @ApiProperty({ nullable: true })
  note!: string | null;

  @ApiProperty({ format: 'date-time' })
  submitted_at!: string;
}
