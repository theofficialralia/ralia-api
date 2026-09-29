import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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
    // Ownership check: the resolved account holder name must share a name with the
    // promoter's own profile — you can only add a bank account in your own name.
    // Lenient (blocks only a total mismatch) to tolerate middle names / name order.
    const profile = await this.prisma.promoterProfile.findUnique({ where: { userId }, select: { fullName: true } });
    if (profile?.fullName && !namesMatch(profile.fullName, dto.account_name)) {
      throw new BadRequestException(
        `The account holder name (“${dto.account_name}”) doesn’t match your profile name. You can only add a bank account in your own name.`,
      );
    }

    // Anti-Sybil (one identity per payout account): the same bank account must not
    // back more than one Ralia identity. A keyed fingerprint lets us detect this
    // without ever comparing the number in the clear.
    const fingerprint = this.crypto.fingerprint(`${dto.bank_code}:${dto.account_number}`);
    const clash = await this.prisma.promoterBankAccount.findFirst({
      where: { accountFingerprint: fingerprint, userId: { not: userId } },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException('This bank account is already linked to another Ralia account. Each account can be used by one person only.');
    }

    const account = await this.prisma.$transaction(async (tx) => {
      // One default at a time.
      await tx.promoterBankAccount.updateMany({ where: { userId }, data: { isDefault: false } });

      return tx.promoterBankAccount.create({
        data: {
          userId,
          bankCode: dto.bank_code,
          accountNumberEnc: this.crypto.encrypt(dto.account_number),
          accountNumberLast4: dto.account_number.slice(-4),
          accountFingerprint: fingerprint,
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

/** Significant name tokens (≥2 letters), lower-cased and accent-stripped. */
function nameTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 2),
  );
}

/**
 * True when two names plausibly belong to the same person — they share at least
 * one significant name token. Only a *total* mismatch is rejected, so "Ada Okafor"
 * vs "OKAFOR ADA C" matches while "Ada Okafor" vs "John Smith" does not.
 */
function namesMatch(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === 0 || tb.size === 0) return true; // nothing to compare on → allow
  for (const t of ta) if (tb.has(t)) return true;
  return false;
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
