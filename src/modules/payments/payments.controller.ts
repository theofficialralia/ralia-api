import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.guard';
import { RequiresIdempotencyKey } from '../../common/idempotency/idempotency.guard';
import { PaymentResultDto, VerifyPaystackDto } from './dto/payments.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@ApiBearerAuth('access-token')
@Roles(Role.CLIENT)
@Controller('campaigns/:id/payments/paystack')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @RequiresIdempotencyKey()
  @ApiOperation({
    summary: 'Confirm a Paystack payment and fund the campaign',
    description:
      'The reference is verified server-side with Paystack before any money moves. On success the campaign escrow is credited and the campaign goes LIVE. Idempotent on the Paystack reference.',
  })
  @ApiOkResponse({ type: PaymentResultDto })
  verify(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyPaystackDto,
  ): Promise<PaymentResultDto> {
    return this.payments.verifyAndFund(user.id, id, dto.reference);
  }
}
