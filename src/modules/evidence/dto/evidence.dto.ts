import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Verdict } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, IsUrl, MaxLength, Min } from 'class-validator';

export class CreateSubmissionDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Which scheduled post this proof answers. Omit to answer the earliest post still awaiting proof.' })
  @IsOptional()
  @IsUUID()
  delivery_slot_id?: string;

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

  @ApiPropertyOptional({ example: 842, description: 'Views the promoter reports on the post; the admin verifies this at approval and pay is pro-rata on the verified figure.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  claimed_views?: number;
}

export class SubmissionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  assignment_id!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'The scheduled post this proof answers.' })
  delivery_slot_id?: string | null;

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

  @ApiProperty({ nullable: true, example: 842, description: 'Views the promoter reported at submission.' })
  claimed_views!: number | null;

  @ApiProperty({ nullable: true, description: 'Admin-verified delivered views, once approved.' })
  verified_reach!: number | null;

  @ApiProperty({ format: 'date-time' })
  submitted_at!: string;
}
