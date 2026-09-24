import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * Meta Conversions API (CAPI) — server-side conversion tracking.
 *
 * Why this exists: the browser Pixel alone loses a large and growing share of
 * conversions to ad-blockers, iOS/ITP and cookie limits. Sending the same event
 * from the server (which always knows a campaign was funded) recovers those and
 * makes ad optimisation far more accurate. The browser and the server send the
 * SAME event with the SAME `event_id`; Meta then deduplicates so the conversion
 * is counted once. See docs/META_CONVERSIONS.md.
 *
 * SECURITY: the access token is a secret. It is read from the server environment
 * only (META_CAPI_ACCESS_TOKEN) and never sent to any frontend. The public Pixel
 * id (== dataset id) is the only Meta value the browser ever sees.
 *
 * Fail-soft: if the env is not configured this is a no-op, and a send that fails
 * is logged and swallowed — CAPI is best-effort telemetry and must never break a
 * payment or a signup.
 */

/** PII we hash before it ever leaves the server, per Meta's matching rules. */
export type CapiUserData = {
  email?: string | null;
  /** Any format; normalised to digits (with country code) before hashing. */
  phone?: string | null;
  /** A stable, non-reversible id for the user (we pass the user id). */
  externalId?: string | null;
  /** NOT hashed — Meta needs these in the clear for matching. */
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
  /** The `_fbp` / `_fbc` browser cookies, forwarded from the client. Not hashed. */
  fbp?: string | null;
  fbc?: string | null;
};

export type CapiEvent = {
  /** A Meta standard event name, e.g. 'Purchase', 'CompleteRegistration'. */
  eventName: string;
  /** Shared with the browser Pixel event for deduplication. Required. */
  eventId: string;
  /** Unix seconds. Defaults to now. */
  eventTime?: number;
  /** 'website' for a browser-originated event we mirror; 'system_generated' for a server-only one (e.g. a webhook backstop). */
  actionSource?: 'website' | 'app' | 'system_generated' | 'other';
  /** The page the browser event fired on — improves matching for 'website' events. */
  eventSourceUrl?: string | null;
  user: CapiUserData;
  /** e.g. { currency: 'NGN', value: 50000, order_id, content_ids }. */
  customData?: Record<string, unknown>;
};

@Injectable()
export class MetaConversionsService {
  private readonly logger = new Logger(MetaConversionsService.name);
  private readonly datasetId = process.env.META_DATASET_ID?.trim();
  private readonly accessToken = process.env.META_CAPI_ACCESS_TOKEN?.trim();
  private readonly graphVersion = process.env.META_GRAPH_VERSION?.trim() || 'v17.0';
  /** Set to a code from Events Manager → Test Events to route sends there while testing. */
  private readonly testEventCode = process.env.META_TEST_EVENT_CODE?.trim() || undefined;

  /** True only when both the dataset id and the access token are present. */
  get configured(): boolean {
    return Boolean(this.datasetId && this.accessToken);
  }

  /** SHA-256 hex of a normalised value, or undefined for empty input. */
  private hash(value: string | null | undefined, normalise: (v: string) => string): string | undefined {
    if (!value) return undefined;
    const normalised = normalise(value.trim());
    if (!normalised) return undefined;
    return createHash('sha256').update(normalised).digest('hex');
  }

  private buildUserData(u: CapiUserData): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    const em = this.hash(u.email, (v) => v.toLowerCase());
    // Meta wants digits only, including country code, no '+' or separators.
    const ph = this.hash(u.phone, (v) => v.replace(/[^0-9]/g, ''));
    const externalId = this.hash(u.externalId, (v) => v.toLowerCase());
    if (em) data.em = [em];
    if (ph) data.ph = [ph];
    if (externalId) data.external_id = [externalId];
    if (u.clientIpAddress) data.client_ip_address = u.clientIpAddress;
    if (u.clientUserAgent) data.client_user_agent = u.clientUserAgent;
    if (u.fbp) data.fbp = u.fbp;
    if (u.fbc) data.fbc = u.fbc;
    return data;
  }

  /**
   * Send one conversion event to Meta. Never throws: unconfigured → no-op,
   * a network/API error is logged and swallowed.
   */
  async send(event: CapiEvent): Promise<void> {
    if (!this.configured) {
      this.logger.debug(`Meta CAPI not configured — skipping ${event.eventName} (${event.eventId}).`);
      return;
    }

    const payload: Record<string, unknown> = {
      data: [
        {
          event_name: event.eventName,
          event_time: event.eventTime ?? Math.floor(Date.now() / 1000),
          event_id: event.eventId,
          action_source: event.actionSource ?? 'website',
          ...(event.eventSourceUrl ? { event_source_url: event.eventSourceUrl } : {}),
          user_data: this.buildUserData(event.user),
          ...(event.customData ? { custom_data: event.customData } : {}),
        },
      ],
      ...(this.testEventCode ? { test_event_code: this.testEventCode } : {}),
    };

    const url = `https://graph.facebook.com/${this.graphVersion}/${this.datasetId}/events?access_token=${encodeURIComponent(
      this.accessToken as string,
    )}`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        // Read the body for the diagnostic, but never log the URL (it carries the token).
        const body = await res.text().catch(() => '');
        this.logger.warn(`Meta CAPI ${event.eventName} HTTP ${res.status}: ${body.slice(0, 500)}`);
        return;
      }
      this.logger.debug(`Meta CAPI ${event.eventName} sent (${event.eventId}).`);
    } catch (err) {
      this.logger.warn(`Meta CAPI ${event.eventName} send failed: ${(err as Error).message}`);
    }
  }
}
