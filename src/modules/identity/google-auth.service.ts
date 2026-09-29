import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';

export type GoogleIdentity = { email: string; emailVerified: boolean; name: string | null; sub: string };

/**
 * Verifies Google "Sign in with Google" ID tokens (the JWT the browser gets from
 * Google Identity Services). The token is validated against Google's public keys
 * and its audience must match our own GOOGLE_CLIENT_ID — so a token minted for a
 * different app is rejected. We only trust the email once Google marks it verified.
 *
 * Configured entirely by env: with no GOOGLE_CLIENT_ID set, sign-in is disabled
 * and every call returns 503, so the feature is dark until an operator wires it up.
 */
@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);
  private readonly clientId = process.env.GOOGLE_CLIENT_ID;
  private readonly client = this.clientId ? new OAuth2Client(this.clientId) : null;

  get enabled(): boolean {
    return this.client !== null;
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    if (!this.client || !this.clientId) {
      throw new ServiceUnavailableException('Google sign-in is not configured on this server.');
    }
    let payload;
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience: this.clientId });
      payload = ticket.getPayload();
    } catch (err) {
      this.logger.warn(`Google ID token verification failed: ${err instanceof Error ? err.message : 'unknown'}`);
      throw new BadRequestException('That Google sign-in could not be verified.');
    }
    if (!payload?.email) throw new BadRequestException('Google did not return an email for this account.');

    return {
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true,
      name: payload.name ?? null,
      sub: payload.sub,
    };
  }
}
