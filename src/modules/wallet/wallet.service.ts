import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccountKind, Withdrawal, WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateConfigService } from '../../common/rate-config/rate-config.service';
import { LedgerService } from '../ledger/ledger.service';
import { toMoney } from '../ledger/money';
import { WalletDto, WithdrawalDto } from '../admin/dto/admin.dto';

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly rateConfig: RateConfigService,
  ) {}

  /** Balance is always derived from postings — there is no balance column (§4). */
  async wallet(promoterId: string): Promise<WalletDto> {
    const accountId = await this.ledger.getOrCreateAccount(AccountKind.PROMOTER_AVAILABLE, promoterId);
    const available = await this.ledger.getBalance(accountId);

    const config = await this.rateConfig.getActive();
    const minimum = config.withdrawalMinimumMinor;

    const inFlight = await this.prisma.withdrawal.aggregate({
      where: { promoterId, status: { in: [WithdrawalStatus.REQUESTED, WithdrawalStatus.APPROVED] } },
      _sum: { amountMinor: true },
    });
    const pending = inFlight._sum.amountMinor ?? 0n;

    return {
      available: toMoney(available),
      pending_withdrawal: toMoney(pending),
      withdrawal_minimum: toMoney(minimum),
      can_withdraw: available - pending >= minimum,
    };
  }

  async listWithdrawals(promoterId: string): Promise<WithdrawalDto[]> {
    const withdrawals = await this.prisma.withdrawal.findMany({
      where: { promoterId },
      orderBy: { createdAt: 'desc' },
    });
    return withdrawals.map(toWithdrawalDto);
  }

  /**
   * Request a payout.
   *
   * Requesting does not move money — the ledger posting happens when the admin
   * records the transfer they actually sent (§5.6). What this must not allow is
   * requesting more than is unencumbered, so already-requested amounts are
   * subtracted from the available balance.
   */
  async requestWithdrawal(promoterId: string, amountMinor: bigint): Promise<WithdrawalDto> {
    const bankAccount = await this.prisma.promoterBankAccount.findFirst({
      where: { userId: promoterId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    if (!bankAccount) {
      throw new BadRequestException('Add your bank details before requesting a withdrawal.');
    }

    const config = await this.rateConfig.getActive();
    if (amountMinor < config.withdrawalMinimumMinor) {
      throw new BadRequestException(
        `The minimum withdrawal is ${toMoney(config.withdrawalMinimumMinor).amount_display}.`,
      );
    }

    const accountId = await this.ledger.getOrCreateAccount(AccountKind.PROMOTER_AVAILABLE, promoterId);
    const available = await this.ledger.getBalance(accountId);

    const inFlight = await this.prisma.withdrawal.aggregate({
      where: { promoterId, status: { in: [WithdrawalStatus.REQUESTED, WithdrawalStatus.APPROVED] } },
      _sum: { amountMinor: true },
    });
    const pending = inFlight._sum.amountMinor ?? 0n;

    if (amountMinor > available - pending) {
      throw new BadRequestException(
        `You can withdraw at most ${toMoney(available - pending).amount_display} right now.`,
      );
    }

    const withdrawal = await this.prisma.withdrawal.create({
      data: {
        promoterId,
        amountMinor,
        bankAccountId: bankAccount.id,
        status: WithdrawalStatus.REQUESTED,
      },
    });

    return toWithdrawalDto(withdrawal);
  }
}

function toWithdrawalDto(w: Withdrawal): WithdrawalDto {
  return {
    id: w.id,
    amount: toMoney(w.amountMinor),
    status: w.status,
    paid_ref: w.paidRef,
    created_at: w.createdAt.toISOString(),
  };
}
