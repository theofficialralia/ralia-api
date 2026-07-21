import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class VerifyPaystackDto {
  @ApiProperty({ example: 'RLA-1a2b3c4d-9f2k84b', description: 'The reference Paystack returned on the client.' })
  @IsString()
  @MinLength(4)
  @MaxLength(120)
  reference!: string;
}

export class PaymentResultDto {
  @ApiProperty({ example: 'LIVE' })
  status!: string;

  @ApiProperty({ example: 'Payment confirmed; your campaign is live.' })
  message!: string;
}
