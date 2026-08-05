import { OtpPurpose } from '@prisma/client';

export const OTP_PROVIDER = Symbol('OTP_PROVIDER');

/** Who the code goes to — a channel picks the contact point it needs. */
export type OtpRecipient = {
  phone: string;
  email: string | null;
};

/**
 * Pluggable OTP delivery — handoff §2. Console in dev; email (MAILER) and WhatsApp
 * adapters slot in behind the same interface, and a multi-channel provider fans one
 * code out to several channels — all without touching auth logic.
 */
export interface OtpProvider {
  readonly name: string;
  send(to: OtpRecipient, code: string, purpose: OtpPurpose): Promise<void>;
}

/** Human-readable action per purpose, shared across delivery channels. */
export function otpPurposeLabel(purpose: OtpPurpose): string {
  switch (purpose) {
    case OtpPurpose.LOGIN:
      return 'sign in';
    case OtpPurpose.PASSWORD_RESET:
      return 'reset your password';
    case OtpPurpose.PHONE_VERIFY:
    default:
      return 'verify your account';
  }
}
