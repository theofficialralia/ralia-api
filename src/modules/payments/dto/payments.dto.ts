import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class VerifyPaystackDto {
  @ApiProperty({ example: 'RLA-1a2b3c4d-9f2k84b', description: 'The reference Paystack returned on the client.' })
  @IsString()
  @MinLength(4)
  @MaxLength(120)
  reference!: string;

  // ── Meta Conversions API deduplication (optional) ──────────────────────────
  // The client generates event_id and fires the browser Pixel `Purchase` with it;
  // the same id is echoed here so the server-side Purchase event Meta receives is
  // deduplicated against the browser one. fbp/fbc are the Meta browser cookies,
  // forwarded to improve match quality. All optional — funding works without them.
  @ApiPropertyOptional({ description: 'Shared event_id for Meta Pixel/CAPI deduplication.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  event_id?: string;

  @ApiPropertyOptional({ description: 'The _fbp browser cookie, for Meta match quality.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fbp?: string;

  @ApiPropertyOptional({ description: 'The _fbc browser cookie (from fbclid), for Meta match quality.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fbc?: string;

  @ApiPropertyOptional({ description: 'The page URL the browser Purchase event fired on.' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  event_source_url?: string;
}

export class PaymentResultDto {
  @ApiProperty({ example: 'LIVE' })
  status!: string;

  @ApiProperty({ example: 'Payment confirmed; your campaign is live.' })
  message!: string;
}
