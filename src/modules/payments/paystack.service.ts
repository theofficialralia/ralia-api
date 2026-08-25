import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

export type PaystackVerification = {
  status: string; // 'success' when the charge went through
  amountMinor: number; // kobo
  currency: string;
  reference: string;
};

export type PaystackBank = { name: string; code: string };
export type ResolvedAccount = { account_name: string; account_number: string; bank_code: string; bypassed: boolean };

/**
 * Enough major Nigerian banks to onboard against when Paystack is unreachable or
 * the dev key's rate limit is spent. Codes are Paystack bank codes.
 */
const FALLBACK_BANKS: PaystackBank[] = [
  { name: 'Access Bank', code: '044' },
  { name: 'Guaranty Trust Bank (GTBank)', code: '058' },
  { name: 'Zenith Bank', code: '057' },
  { name: 'First Bank of Nigeria', code: '011' },
  { name: 'United Bank For Africa (UBA)', code: '033' },
  { name: 'Union Bank', code: '032' },
  { name: 'Fidelity Bank', code: '070' },
  { name: 'FCMB', code: '214' },
  { name: 'Sterling Bank', code: '232' },
  { name: 'Stanbic IBTC Bank', code: '221' },
  { name: 'Ecobank Nigeria', code: '050' },
  { name: 'Wema Bank', code: '035' },
  { name: 'Kuda Bank', code: '50211' },
  { name: 'Opay', code: '999992' },
  { name: 'PalmPay', code: '999991' },
  { name: 'Moniepoint MFB', code: '50515' },
];

const BYPASS_ACCOUNT_NAME = 'RALIA DEV ACCOUNT';

/**
 * Verifies a Paystack transaction server-side with the secret key. The client's
 * success callback is never trusted on its own — anyone can call our endpoint
 * with a made-up reference, so the money only moves after Paystack itself
 * confirms the charge and the amount.
 */
@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);

  private get secret(): string {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) {
      throw new ServiceUnavailableException(
        'Card payments are not configured (PAYSTACK_SECRET_KEY is unset).',
      );
    }
    return key;
  }

  async verify(reference: string): Promise<PaystackVerification> {
    const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${this.secret}` },
    });

    if (!res.ok) {
      this.logger.warn(`Paystack verify HTTP ${res.status} for ${reference}`);
      throw new ServiceUnavailableException('Could not verify the payment with Paystack.');
    }

    const body = (await res.json()) as { status?: boolean; data?: { status?: string; amount?: number; currency?: string; reference?: string } };
    if (!body.status || !body.data) {
      throw new ServiceUnavailableException('Paystack returned an unexpected response.');
    }

    return {
      status: body.data.status ?? 'unknown',
      amountMinor: body.data.amount ?? 0,
      currency: body.data.currency ?? 'NGN',
      reference: body.data.reference ?? reference,
    };
  }

  /**
   * A webhook is authentic iff x-paystack-signature is HMAC-SHA512(rawBody) under
   * our secret. Constant-time compared so a mismatch leaks no timing signal.
   */
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = createHmac('sha512', this.secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Dev bypass — when PAYSTACK_DEV_BYPASS is on, Paystack failures (e.g. the
   * dev key's rate limit) fall back to a stub instead of blocking onboarding.
   * Never enable in production.
   */
  private get bypass(): boolean {
    return process.env.PAYSTACK_DEV_BYPASS === 'true' || process.env.PAYSTACK_DEV_BYPASS === '1';
  }

  /** The bank list for the "where you get paid" dropdown. */
  async listBanks(): Promise<PaystackBank[]> {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (key) {
      try {
        const res = await fetch('https://api.paystack.co/bank?country=nigeria&perPage=100', {
          headers: { Authorization: `Bearer ${key}` },
        });
        const body = (await res.json().catch(() => ({}))) as { status?: boolean; data?: { name?: string; code?: string }[] };
        if (res.ok && body.status && Array.isArray(body.data)) {
          const seen = new Set<string>();
          const banks = body.data
            .filter((b): b is { name: string; code: string } => !!b.name && !!b.code)
            .filter((b) => (seen.has(b.code) ? false : (seen.add(b.code), true)))
            .map((b) => ({ name: b.name, code: b.code }))
            .sort((a, b) => a.name.localeCompare(b.name));
          if (banks.length) return banks;
        }
        this.logger.warn(`Paystack listBanks HTTP ${res.status}`);
      } catch (e) {
        this.logger.warn(`Paystack listBanks error: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (this.bypass || !key) return FALLBACK_BANKS;
    throw new ServiceUnavailableException('Could not fetch the bank list from Paystack.');
  }

  /** Resolve an account number + bank code to the account holder's name. */
  async resolveAccount(accountNumber: string, bankCode: string): Promise<ResolvedAccount> {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (key) {
      try {
        const res = await fetch(
          `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
          { headers: { Authorization: `Bearer ${key}` } },
        );
        const body = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: { account_name?: string } };
        if (res.ok && body.status && body.data?.account_name) {
          return { account_name: body.data.account_name, account_number: accountNumber, bank_code: bankCode, bypassed: false };
        }
        this.logger.warn(`Paystack resolve HTTP ${res.status}: ${body.message ?? ''}`);
        // A genuine bad account (not a rate limit) should be surfaced when not bypassing.
        if (!this.bypass) throw new BadRequestException(body.message || 'Could not verify that account. Check the number and bank.');
      } catch (e) {
        if (e instanceof BadRequestException) throw e;
        this.logger.warn(`Paystack resolve error: ${e instanceof Error ? e.message : e}`);
        if (!this.bypass) throw new ServiceUnavailableException('Could not reach Paystack to verify the account.');
      }
    }
    // Bypass on (or no key): stub name so dev testing isn't blocked by Paystack limits.
    if (this.bypass || !key) return { account_name: BYPASS_ACCOUNT_NAME, account_number: accountNumber, bank_code: bankCode, bypassed: true };
    throw new ServiceUnavailableException('Account verification is not configured.');
  }
}
