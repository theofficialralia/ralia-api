import { OtpPurpose } from '@prisma/client';

export const OTP_PROVIDER = Symbol('OTP_PROVIDER');

/**
 * Pluggable OTP delivery — handoff §2. Console in dev; an SMS or WhatsApp
 * adapter slots in behind the same interface without touching auth logic.
 */
export interface OtpProvider {
  readonly name: string;
  send(to: string, code: string, purpose: OtpPurpose): Promise<void>;
}
