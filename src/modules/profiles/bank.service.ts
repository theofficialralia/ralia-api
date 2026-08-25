import { Injectable, NotFoundException } from '@nestjs/common';
import { PromoterBankAccount } from '@prisma/client';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaystackService, PaystackBank, ResolvedAccount } from '../payments/paystack.service';
import { BankAccountDto, CreateBankAccountDto } from './dto/profile.dto';

/**
 * Bank details are encrypted at rest with a key separate from the DB credential,
 * and never returned or logged in full — handoff §7.
 *
 * MVP takes the account name as typed. Confirming it against the bank would mean
 * a name-resolution integration, and §11 puts payment providers out of scope; the
 * admin eyeballs the name when they record the transfer.
 */
@Injectable()
export class BankService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: FieldEncryptionService,
    private readonly paystack: PaystackService,
  ) {}

  /** Banks for the "where you get paid" dropdown (Paystack, with a dev fallback). */
  listBanks(): Promise<PaystackBank[]> {
    return this.paystack.listBanks();
  }

  /** Resolve an account number + bank code to the holder's name (Paystack + dev bypass). */
  resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
    return this.paystack.resolveAccount(accountNumber, bankCode);
  }

  async list(userId: string): Promise<BankAccountDto[]> {
    const accounts = await this.prisma.promoterBankAccount.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return accounts.map(toDto);
  }

  async create(userId: string, dto: CreateBankAccountDto): Promise<BankAccountDto> {
    const account = await this.prisma.$transaction(async (tx) => {
      // One default at a time.
      await tx.promoterBankAccount.updateMany({ where: { userId }, data: { isDefault: false } });

      return tx.promoterBankAccount.create({
        data: {
          userId,
          bankCode: dto.bank_code,
          accountNumberEnc: this.crypto.encrypt(dto.account_number),
          accountNumberLast4: dto.account_number.slice(-4),
          accountName: dto.account_name,
          isDefault: true,
        },
      });
    });

    return toDto(account);
  }

  /**
   * The only path that returns a plaintext account number. Used when an admin is
   * about to send a transfer (B8) — nothing else should call it.
   */
  async revealForPayout(bankAccountId: string): Promise<{ bankCode: string; accountNumber: string; accountName: string }> {
    const account = await this.prisma.promoterBankAccount.findUnique({ where: { id: bankAccountId } });
    if (!account) throw new NotFoundException('No such bank account.');

    return {
      bankCode: account.bankCode,
      accountNumber: this.crypto.decrypt(account.accountNumberEnc),
      accountName: account.accountName,
    };
  }
}

function toDto(account: PromoterBankAccount): BankAccountDto {
  return {
    id: account.id,
    bank_code: account.bankCode,
    account_number_masked: `******${account.accountNumberLast4}`,
    account_name: account.accountName,
    is_default: account.isDefault,
  };
}
