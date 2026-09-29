import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Envelope encryption for individual columns — bank account numbers today,
 * identity documents later.
 *
 * The key is FIELD_ENCRYPTION_KEY, deliberately separate from the database
 * credential (handoff §7): a dump of the database, on its own, decrypts nothing.
 *
 * AES-256-GCM, so the ciphertext is authenticated — a tampered value fails to
 * decrypt rather than returning plausible garbage.
 */
@Injectable()
export class FieldEncryptionService {
  private readonly key: Buffer;

  constructor() {
    const hex = process.env.FIELD_ENCRYPTION_KEY;
    if (!hex) {
      throw new Error('FIELD_ENCRYPTION_KEY is not set — bank details cannot be stored safely.');
    }
    const key = Buffer.from(hex, 'hex');
    if (key.length !== 32) {
      throw new Error(
        `FIELD_ENCRYPTION_KEY must be 32 bytes as 64 hex chars (got ${key.length} bytes). Generate: openssl rand -hex 32`,
      );
    }
    this.key = key;
  }

  /** Returns `v1.iv.tag.ciphertext`, all base64url. The version prefix leaves room to rotate keys. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string): string {
    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('Ciphertext is not in the expected v1 format');
    }
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64!, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64!, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64!, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /**
   * A deterministic, keyed fingerprint for equality/dedup — the same input always
   * yields the same output, but it is neither reversible nor guessable without the
   * key. Unlike {@link encrypt} (randomised IV), this is stable, so it can be
   * indexed and compared to detect the same secret value across rows.
   */
  fingerprint(plaintext: string): string {
    return createHmac('sha256', this.key).update(plaintext).digest('hex');
  }

  /** Constant-time compare of a candidate against a stored ciphertext's plaintext. */
  matches(payload: string, candidate: string): boolean {
    try {
      const plain = Buffer.from(this.decrypt(payload), 'utf8');
      const other = Buffer.from(candidate, 'utf8');
      return plain.length === other.length && timingSafeEqual(plain, other);
    } catch {
      return false;
    }
  }
}
