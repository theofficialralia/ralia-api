import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

export type PaystackVerification = {
  status: string; // 'success' when the charge went through
  amountMinor: number; // kobo
  currency: string;
  reference: string;
};

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
}
