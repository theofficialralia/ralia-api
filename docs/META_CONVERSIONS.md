# Meta Conversions API (CAPI) — server-side conversion tracking

Ralia tracks marketing conversions **twice**: once from the browser (the Meta
Pixel) and once from the server (the Conversions API). Meta stitches the two
together by a shared `event_id` and counts the conversion once. This recovers the
large and growing share of conversions the browser Pixel alone loses to
ad-blockers, iOS/ITP and cookie limits, and makes ad optimisation far more
accurate.

## The pieces

| Where | What | Secret? |
|---|---|---|
| `ralia-api` `MetaConversionsService` (`src/common/marketing/`) | Sends events server-side to `graph.facebook.com/<ver>/<dataset>/events` | Uses the **secret** access token |
| `ralia-client` `lib/meta-pixel.ts` + `components/MetaPixel.tsx` | Loads the browser Pixel, fires events, generates `event_id` | Public Pixel id only |

## Configuration

**Backend (server-only secrets):**

```
META_DATASET_ID=1831543587845464      # same number as the public Pixel id — NOT a secret
META_CAPI_ACCESS_TOKEN=<secret>       # SECRET. server-only. never in a frontend or public repo
META_GRAPH_VERSION=v17.0
META_TEST_EVENT_CODE=                  # optional; routes sends to Events Manager → Test Events
```

If `META_DATASET_ID` or `META_CAPI_ACCESS_TOKEN` is unset, the service is a
**no-op** — nothing is sent, nothing breaks.

**Frontend (public):**

```
NEXT_PUBLIC_META_PIXEL_ID=1831543587845464   # public; safe to ship
```

> **The access token is a secret.** It lives only in the backend environment.
> It must never appear in any `NEXT_PUBLIC_*` var, frontend bundle, or public
> repo. If it is ever committed or shared, rotate it in Events Manager →
> Settings → Conversions API → Generate access token.

## Events we send

| Event | Where it fires | Deduplicated? | Notes |
|---|---|---|---|
| **PageView** | Browser, every route change | Browser only | Baseline pixel traffic |
| **CompleteRegistration** | Browser, on signup completion (client OTP verify) | Browser only | Client acquisition |
| **InitiateCheckout** | Browser, when the Paystack popup opens | Browser only | Funnel signal toward Purchase |
| **Purchase** | **Browser + server**, on a funded campaign | **Yes — shared `event_id`** | The money event. `value` = campaign price (NGN), `currency` = NGN |

`Purchase` is the important one and the only one sent both ways today. The client
generates an `event_id` when the client clicks pay, fires the browser `Purchase`
with it, and forwards the same id (plus the `_fbp`/`_fbc` cookies and the page
URL) to `POST /v1/campaigns/:id/payments/paystack/verify`. The backend, on the
first successful settle of that Paystack reference, sends the server-side
`Purchase` with the same `event_id`. Meta deduplicates the pair.

The Paystack **webhook backstop** (browser closed after paying) also settles the
charge; it has no browser event to dedupe against, so it sends `Purchase` with a
deterministic `event_id` of `purchase:<reference>` and `action_source:
system_generated`. That deterministic id also stops our own retries from
double-counting.

## Privacy & hashing

`MetaConversionsService` SHA-256-hashes all PII (email, phone, external id) before
it leaves the server, per Meta's matching rules. Phone is reduced to digits and
email is lower-cased/trimmed first. IP address, user-agent and the `_fbp`/`_fbc`
cookies are sent **unhashed** (Meta requires them in the clear for matching). The
raw email/phone never appear in the request body — see the service spec.

## Testing

1. Set `META_TEST_EVENT_CODE` to a code from Events Manager → Test Events.
2. Fund a campaign end-to-end. You should see both the browser `Purchase` and the
   server `Purchase` arrive, collapsed into one deduplicated event.
3. Unset `META_TEST_EVENT_CODE` before going live.
