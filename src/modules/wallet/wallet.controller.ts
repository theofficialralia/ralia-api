import { Body, Controller, Get, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthedUser } from '../../common/auth/jwt-auth.guard';
import { Roles } from '../../common/auth/roles.guard';
import { RequestWithdrawalDto, WalletDto, WithdrawalDto } from '../admin/dto/admin.dto';
import { WalletService } from './wallet.service';

@ApiTags('wallet')
@ApiBearerAuth('access-token')
@Roles(Role.PROMOTER)
@Controller()
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('wallet')
  @ApiOperation({ summary: 'My balance', description: 'Derived from ledger postings; there is no balance column.' })
  @ApiOkResponse({ type: WalletDto })
  get(@CurrentUser() user: AuthedUser): Promise<WalletDto> {
    return this.wallet.wallet(user.id);
  }

  @Get('withdrawals')
  @ApiOperation({ summary: 'My withdrawals' })
  @ApiOkResponse({ type: [WithdrawalDto] })
  list(@CurrentUser() user: AuthedUser): Promise<WithdrawalDto[]> {
    return this.wallet.listWithdrawals(user.id);
  }

  @Post('withdrawals')
  @ApiOperation({
    summary: 'Request a withdrawal',
    description:
      'Does not move money — the admin records the transfer they send. Rejected below the configured minimum or above the unencumbered balance.',
  })
  @ApiCreatedResponse({ type: WithdrawalDto })
  request(@CurrentUser() user: AuthedUser, @Body() dto: RequestWithdrawalDto): Promise<WithdrawalDto> {
    return this.wallet.requestWithdrawal(user.id, BigInt(dto.amount_minor));
  }
}
