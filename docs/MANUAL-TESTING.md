# Manual API testing guide

How to exercise every Ralia endpoint by hand in Swagger UI, organised by module
and by user journey, with payloads that are known to work.

Every example below was run against the live API before being written down.
Two are marked *(covered by automated tests, no fixture at the time of writing)*
where a manual fixture wasn't available.

**Swagger UI:** <http://localhost:3000/docs> · **Raw spec:** `/docs/openapi.json`

If you only want to know that the whole thing works, run `make verify-loop` —
it drives the entire loop and asserts the money. This guide is for exploring,
for testing the paths that script doesn't cover, and for QA against the product's
promises.

---

## 1. Before you start

```bash
make up          # postgres, redis, minio, mailpit, migrate, seed, run
# then open http://localhost:3000/docs
```

### 1.1 The three things that will otherwise waste your afternoon

**a) Getting OTP codes.** Registration sends a code you must enter to verify.
In dev the code goes to the server console *and* to `.dev-otp.log`:

```bash
tail -f .dev-otp.log
# +2348011123456 PHONE_VERIFY 481920
```

**b) Getting an admin token.** There is deliberately no admin signup — you cannot
become an admin through the API. The seed creates one, and you mint a token for it:

```bash
ADMIN_ID=$(docker compose exec -T postgres psql -U ralia -d ralia -tAqc \
  "SELECT id FROM users WHERE email='admin@ralia.test';" | tr -d ' ')
SECRET=$(grep '^JWT_ACCESS_SECRET=' .env | cut -d= -f2)
node -e "console.log(require('jsonwebtoken').sign({sub:'$ADMIN_ID',roles:['ADMIN']},'$SECRET',{expiresIn:'2h'}))"
```

Paste the result into Swagger's **Authorize** button. This friction is deliberate:
admin is not a self-service role. It is the one genuinely awkward part of manual
testing and there is no way around it short of building an admin invite flow,
which is out of scope.

**c) Authorizing in Swagger.** Click **Authorize** (top right), paste the raw JWT
(no `Bearer ` prefix), click Authorize, then Close. You are now that user for
every request. **To switch users you must Authorize again with a different token** —
this is the single most common source of confusing 403s.

### 1.2 Rules the API enforces that will bite you

| Rule | What you'll see |
|---|---|
| Phone must be E.164, digits only (`+2348012345678`) | `400` — letters in the number fail validation |
| Registration is rate-limited to **5/min** | `429 ThrottlerException` |
| OTP request **3/min**, verify **10/min** | `429` |
| Money endpoints need an `Idempotency-Key` header, **UUID format** | `400` without it |
| A campaign must have `min_effective_reach` set before `/quote` | `400` — it's the per-slot pricing basis |
| Offers can only be sent on a **LIVE** (funded) campaign | `400` |
| Withdrawals have a **₦5,000 minimum** (`500000` kobo) | `400` below it |
| Rejecting anything needs a `reason` of **≥5 characters** | `400` |

Generate an idempotency key with `uuidgen` (macOS/Linux) or any UUID v4 tool.

### 1.3 Money is always integer kobo

`amount_minor` is kobo (₦1 = 100 kobo). Responses carry both forms:

```json
{ "amount_minor": 603750, "amount_display": "₦6,037.50" }
```

### 1.4 The numbers that make the full money path testable

To reach a balance above the ₦5,000 withdrawal minimum in one campaign, use:

| Input | Value | Produces |
|---|---|---|
| `claimed_audience` on INSTAGRAM | `5000000` | `effective_reach` **300,000** (×0.10 platform ×0.6 SELF tier) |
| `min_effective_reach` in targeting | `250000` | slot price **₦8,625.00** (862,500 kobo) |
| with 3 filters set (states, platforms, min reach) | multiplier 1.15 | promoter fee **₦6,037.50** (603,750 kobo) |

Smaller numbers work fine for everything except the withdrawal step, where the
promoter's balance would sit below the minimum — which is itself a valid thing
to test (§5.3 below).

---

## 2. Module reference

### 2.1 `identity` — accounts, sessions, consent

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/auth/register` | Client or promoter. Consent rows written here. |
| POST | `/v1/auth/otp/request` | Always `202`, even for unknown numbers |
| POST | `/v1/auth/otp/verify` | Verifies phone, returns tokens |
| POST | `/v1/auth/login` | |
| POST | `/v1/auth/refresh` | Rotates; old token is revoked |
| POST | `/v1/auth/logout` | `204` |
| GET | `/v1/auth/me` | Requires auth |

**Register a promoter**
```json
{
  "email": "ada@example.com",
  "phone_e164": "+2348011223344",
  "password": "a long enough passphrase",
  "role": "PROMOTER",
  "accepted_terms": true,
  "accepted_privacy": true
}
```

**Register a client** — `org_name` is required for `CLIENT`:
```json
{
  "email": "biz@example.com",
  "phone_e164": "+2348011223355",
  "password": "a long enough passphrase",
  "role": "CLIENT",
  "org_name": "Naija Threads",
  "accepted_terms": true,
  "accepted_privacy": true
}
```

**Verify the phone** (code from `.dev-otp.log`):
```json
{ "phone_e164": "+2348011223344", "code": "481920" }
```
Returns `access_token` and `refresh_token`. Authorize with the access token.

**Login / refresh / logout**
```json
{ "email": "ada@example.com", "password": "a long enough passphrase" }
{ "refresh_token": "<the refresh token>" }
```

---

### 2.2 `profiles` — questionnaire, channels, bank

| Method | Path | Notes |
|---|---|---|
| GET/PUT | `/v1/promoters/me/profile` | Partial save; resumable |
| GET/POST | `/v1/promoters/me/channels` | POST returns computed reach |
| DELETE | `/v1/promoters/me/channels/{id}` | `204` |
| GET/POST | `/v1/promoters/me/bank` | Returned masked only |

**Save the questionnaire** — send any subset; omitted fields are left alone:
```json
{
  "full_name": "Ada Okafor",
  "dob": "1996-04-12",
  "location_state": "Lagos",
  "languages_spoken": ["English", "Igbo"],
  "preferred_categories": ["Fashion", "Tech"],
  "max_campaigns_per_week": 3
}
```

**Add a channel**
```json
{ "platform": "INSTAGRAM", "handle": "@adastyles", "claimed_audience": 5000000 }
```
Platforms: `WHATSAPP_STATUS` `WHATSAPP_GROUP` `INSTAGRAM` `X` `TIKTOK` `FACEBOOK`
`TELEGRAM` `LINKEDIN` `OFFLINE`. A group channel also needs `group_members`:
```json
{ "platform": "WHATSAPP_GROUP", "claimed_audience": 800, "is_group": true,
  "group_members": 800, "active_participants": 240 }
```

**Bank details**
```json
{ "bank_code": "058", "account_number": "0123456789", "account_name": "ADA OKAFOR" }
```

---

### 2.3 `campaigns` — draft, targeting, pricing, assets

| Method | Path | Notes |
|---|---|---|
| POST/GET | `/v1/campaigns` | |
| GET/PATCH | `/v1/campaigns/{id}` | Editing a quoted campaign clears its price |
| PUT | `/v1/campaigns/{id}/targeting` | |
| POST | `/v1/campaigns/{id}/quote` | Freezes the price, → `QUOTED` |
| POST | `/v1/campaigns/{id}/submit` | → `PENDING_APPROVAL` |
| GET/POST | `/v1/campaigns/{id}/assets` | multipart |

**Create**
```json
{
  "name": "Harmattan Drop",
  "objective": "AWARENESS",
  "description": "Drive awareness for the new collection.",
  "promoter_instructions": "Post the image to your status and leave it up 24h.",
  "destination_url": "https://naijathreads.example/shop",
  "slots_total": 5
}
```
Objectives: `AWARENESS` (×1.0) `WEBSITE_VISIT` (×1.1) `APP_INSTALL` (×1.25)
`LEAD_GEN` (×1.4) `PURCHASE` (×1.5).

**Targeting** — each field set adds 5% to the price, capped at +35%:
```json
{
  "states": ["Lagos", "Oyo"],
  "age_min": 18,
  "age_max": 45,
  "languages": ["English"],
  "categories": ["Fashion"],
  "platforms": ["INSTAGRAM"],
  "min_effective_reach": 250000,
  "roles": ["DISTRIBUTOR"]
}
```
Roles: `DISTRIBUTOR` `CREATOR` `PARTICIPATOR` `INFLUENCER`.

**Assets** (multipart — use Swagger's file picker). A `CAPTION` asset is text-only
and needs no file; `IMAGE` / `VIDEO` / `POSTER` / `LOGO` / `DOCUMENT` require one
(≤10 MB, jpeg/png/webp/gif/mp4/pdf).

| Field | Example |
|---|---|
| `kind` | `CAPTION` |
| `caption_text` | `Shop the collection — link in my status.` |

---

### 2.4 `matching` — candidates, offers, assignments

| Method | Path | Who |
|---|---|---|
| GET | `/v1/campaigns/{id}/candidates` | Admin |
| POST | `/v1/campaigns/{id}/offers` | Admin |
| GET | `/v1/offers` | Promoter |
| POST | `/v1/offers/{id}/accept` | Promoter |
| POST | `/v1/offers/{id}/decline` | Promoter |

**Send offers** (promoter ids come from the candidates list):
```json
{ "promoter_ids": ["b1f2...-uuid", "c3d4...-uuid"] }
```

Accept returns the `tracking_token` — keep it for the next module.

---

### 2.5 `tracking` — the public redirect

| Method | Path | Notes |
|---|---|---|
| GET | `/r/{token}` | **No `/v1`**, no auth. Returns `302`. |

Open `http://localhost:3000/r/<token>` in a browser. Swagger will follow the
redirect, so a browser or `curl -i` shows the `302` more clearly. Unknown token → `404`.

---

### 2.6 `evidence` — proof of posting

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/assignments/{id}/submission` | multipart, screenshot required |
| GET | `/v1/assignments/{id}/submissions` | |

| Field | Example |
|---|---|
| `file` | any jpeg/png/webp screenshot |
| `public_url` | `https://instagram.com/p/abc123` (optional — a WhatsApp status has none) |
| `note` | `Posted at 9am, left up 24h.` |

Every submission comes back `PENDING`. `auto_flag: true` means the screenshot
perceptually matches one already submitted — see §5.2.

---

### 2.7 `admin` — decisions, money, audit

Two capabilities are enforced **separately**, so an account holding only one gets
`403` on the other's endpoints.

| Capability | Endpoints |
|---|---|
| `REVIEW_EVIDENCE` | approve/reject promoters, campaigns, submissions; their queues |
| `RECORD_MONEY` | fund campaign, approve/record withdrawals; withdrawal queue |

| Method | Path | Body |
|---|---|---|
| GET | `/v1/admin/queues/{promoters\|campaigns\|submissions\|withdrawals}` | — |
| POST | `/v1/admin/promoters/{id}/approve` | — |
| POST | `/v1/admin/promoters/{id}/reject` | `reason` |
| POST | `/v1/admin/campaigns/{id}/approve` | — |
| POST | `/v1/admin/campaigns/{id}/reject` | `reason` |
| POST | `/v1/admin/campaigns/{id}/fund` | amount + **Idempotency-Key** |
| POST | `/v1/admin/submissions/{id}/approve` | **Idempotency-Key** |
| POST | `/v1/admin/submissions/{id}/reject` | `reason` |
| POST | `/v1/admin/withdrawals/{id}/approve` | — |
| POST | `/v1/admin/withdrawals/{id}/record-paid` | `paid_ref` + **Idempotency-Key** |

**Fund a campaign** — the amount must equal the quoted price exactly:
```json
{ "amount_minor": 862500, "reference": "GTB transfer 8837261" }
```

**Reject anything**
```json
{ "reason": "The campaign creative is not visible in this screenshot." }
```

**Record a payout**
```json
{ "paid_ref": "Zenith transfer 552117" }
```

---

### 2.8 `wallet` — promoter money

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/wallet` | Balance derived from ledger postings |
| GET | `/v1/withdrawals` | |
| POST | `/v1/withdrawals` | `{ "amount_minor": 603750 }` |

---

## 3. Journeys, and the promise each one tests

The MVP exists to validate two things: **will businesses pay for peer
distribution, and will promoters reliably participate for money.** Each journey
below tests one of those promises end to end.

### Journey A — "A business can buy real distribution and see proof"
*Value proposition: peer distribution that is targeted, priced transparently, and evidenced.*

| # | Action | Expect |
|---|---|---|
| 1 | Register client, verify phone, Authorize | tokens |
| 2 | `POST /campaigns` | `DRAFT`, `price: null` |
| 3 | `PUT /targeting` with `min_effective_reach: 250000` | `DRAFT` |
| 4 | `POST /quote` | price **₦8,625.00**, fee **₦6,037.50**, eligible count |
| 5 | `POST /assets` (CAPTION) | `201` |
| 6 | `POST /submit` | `PENDING_APPROVAL` |
| 7 | *(admin funds — Journey C)* | `LIVE` |
| 8 | `GET /campaigns/{id}` | `slots_filled` rises as promoters accept |

**What this proves:** the business names an audience, sees a deterministic price
before committing, and the price does not move afterwards.

### Journey B — "A promoter can do work and get paid"
*Value proposition: reliable payment for verified promotion.*

| # | Action | Expect |
|---|---|---|
| 1 | Register promoter, verify, Authorize | tokens |
| 2 | `PUT /promoters/me/profile` (partial, twice) | earlier answers preserved |
| 3 | `POST /promoters/me/channels` `claimed_audience: 5000000` | `effective_reach: 300000` |
| 4 | `POST /promoters/me/bank` | masked `******6789` |
| 5 | `GET /promoters/me/profile` | `AWAITING_APPROVAL`, `missing: []` |
| 6 | *(admin approves — Journey C)* | `ACTIVE` |
| 7 | `GET /offers` | the offer, with its fee |
| 8 | `POST /offers/{id}/accept` | assignment + `tracking_token` |
| 9 | Open `/r/{token}` | `302` |
| 10 | `POST /assignments/{id}/submission` | `PENDING`, `auto_flag: false` |
| 11 | *(admin approves — Journey C)* | |
| 12 | `GET /wallet` | **₦6,037.50**, `can_withdraw: true` |
| 13 | `POST /withdrawals` `{"amount_minor": 603750}` | `REQUESTED` |
| 14 | *(admin approves + records — Journey C)* | |
| 15 | `GET /wallet` | **₦0.00** |

**What this proves:** a promoter can see what they'll earn before accepting, prove
they did the work, and be paid exactly that amount.

### Journey C — "Ralia can keep it honest"
*Value proposition: trustworthy proof and exact money — the thing that makes the other two safe.*

| # | Action | Expect |
|---|---|---|
| 1 | Authorize as admin | |
| 2 | `GET /admin/queues/promoters` | the pending promoter |
| 3 | `POST /admin/promoters/{id}/approve` | `ACTIVE`, channels activated |
| 4 | `GET /admin/queues/campaigns` | the submitted campaign |
| 5 | `POST /admin/campaigns/{id}/approve` | `CONFIRMING_PAYMENT` |
| 6 | `POST /admin/campaigns/{id}/fund` + key | `LIVE` |
| 7 | `GET /campaigns/{id}/candidates` | only promoters passing every filter |
| 8 | `POST /campaigns/{id}/offers` | offer created |
| 9 | `GET /admin/queues/submissions` | the proof, with `auto_flag` |
| 10 | `POST /admin/submissions/{id}/approve` + key | promoter paid |
| 11 | `POST /admin/withdrawals/{id}/approve` | `APPROVED` |
| 12 | `POST /admin/withdrawals/{id}/record-paid` + key | `PAID` |

Then confirm the trail — every decision above is recorded:
```bash
docker compose exec -T postgres psql -U ralia -d ralia -c \
  "SELECT action, entity_type, reason, created_at FROM audit_log ORDER BY created_at DESC LIMIT 10;"
```

### Journey D — the whole loop
Run A, B and C interleaved in the order the numbers imply, or just run
`make verify-loop`, which does exactly this and asserts the money at each step.

---

## 4. Checking the money is actually right

After Journey D, these should hold. This is what separates "the endpoints
returned 200" from "the money is correct".

**The payout was one balanced transaction:**
```bash
docker compose exec -T postgres psql -U ralia -d ralia -c "
SELECT t.kind, e.direction, e.amount_minor, a.kind AS account
FROM ledger_entries e
JOIN ledger_transactions t ON t.id = e.transaction_id
JOIN accounts a ON a.id = e.account_id
WHERE t.kind = 'SUBMISSION_PAYOUT' ORDER BY t.created_at DESC, e.direction;"
```
Expect exactly three legs: one `DEBIT` on `CAMPAIGN_ESCROW`, and two `CREDIT`s —
the promoter's fee and Ralia's take — summing to the debit.

**The books close** (cash held equals everything owed plus earned):
```bash
docker compose exec -T postgres psql -U ralia -d ralia -c "
SELECT
  SUM(CASE WHEN a.kind='BANK_CLEARING' THEN (CASE WHEN e.direction='DEBIT' THEN e.amount_minor ELSE -e.amount_minor END) ELSE 0 END) AS cash_held,
  SUM(CASE WHEN a.kind<>'BANK_CLEARING' THEN (CASE WHEN e.direction='CREDIT' THEN e.amount_minor ELSE -e.amount_minor END) ELSE 0 END) AS owed_plus_earned
FROM ledger_entries e JOIN accounts a ON a.id = e.account_id;"
```
The two numbers must be equal. If they ever differ, stop and report it.

---

## 5. Adversarial tests — the guarantees, not the happy path

These are the tests worth running most, because they check the promises rather
than the plumbing.

### 5.1 Money cannot be moved twice
Approve the same submission twice **with the same `Idempotency-Key`** → both
return `200`, but `GET /wallet` moved once. Now try again with a **different**
key → `409`, because that is a genuine second decision, not a retry.

Same for `/fund` and `/record-paid`. Omit the header entirely → `400`.

### 5.2 Recycled proof is caught
Submit a screenshot on one assignment. Then submit **the same image** on a
different promoter's assignment → `auto_flag: true`, and the artifact links back
to the original.

It survives re-saving: shrink the image and re-save it as JPEG, and it is still
flagged. It does **not** survive cropping — a ~5% crop evades detection, which is
why nothing auto-approves and every submission still reaches a human.

Note both submissions stay `PENDING`. The flag informs the reviewer; it does not
reject anything.

### 5.3 A promoter cannot take more than they earned
- Withdraw below ₦5,000 → `400` naming the minimum.
- Withdraw more than the balance → `400`.
- Withdraw the full balance, then request again before it is paid → `400`
  (already-requested amounts are subtracted).
- `record-paid` on a withdrawal that was never approved → `409`.

### 5.4 The two admin powers are separable
Mint a token for an admin holding only `REVIEW_EVIDENCE`:
```sql
UPDATE user_roles SET capabilities = '{REVIEW_EVIDENCE}' WHERE role = 'ADMIN';
```
That admin can approve promoters but gets `403` on `/fund`. Swap to
`'{RECORD_MONEY}'` and it reverses. Restore with `'{REVIEW_EVIDENCE,RECORD_MONEY}'`.

### 5.5 People can only see their own things
- A promoter calling `/v1/campaigns` → `403`
- A client calling `/v1/promoters/me/profile` → `403`
- Either calling `/v1/admin/...` → `403`
- One client fetching another's campaign → `404`, not `403` (a `403` would confirm the id exists)
- Accepting someone else's offer → `404`

### 5.6 Suspension takes effect immediately
While a promoter is Authorized and working, suspend them:
```sql
UPDATE users SET status = 'SUSPENDED' WHERE email = 'ada@example.com';
```
Their **existing, still-valid** token now gets `403` on the next call — the guard
reads the user each request rather than trusting the token. Restore with `'ACTIVE'`.

### 5.7 Pricing is frozen once quoted
Quote a campaign, note the price, then change the rate:
```sql
UPDATE rate_config SET rpm_minor = 6000 WHERE is_active = true;
```
`GET /campaigns/{id}` still shows the original price. Restore to `3000`.
Now `PATCH` the campaign → it drops back to `DRAFT` with `price: null`, because a
stale price must never survive a content change into approval.

### 5.8 Slots cannot be oversold
Create a 1-slot campaign, fund it, send offers to two promoters, and have both
accept. Exactly one gets an assignment; the other gets `409 This campaign is full.`

### 5.9 Consent is recorded where data is collected
After saving `dob` and `gender`, check:
```sql
SELECT purpose, granted, policy_version FROM consents WHERE user_id = '<id>';
```
Expect separate `DATA_DOB` and `DATA_GENDER` rows, individually revocable —
not one blanket agreement.

### 5.10 Private data stays private
- `GET /promoters/me/bank` → only `******6789`, never the full number.
- The stored value is ciphertext:
  `SELECT account_number_enc FROM promoter_bank_accounts LIMIT 1;` → starts `v1.`
- Click IPs are hashed: `SELECT ip_hash FROM click_events LIMIT 1;` → 64 hex chars,
  no IP recoverable.
- Grep the server log for a password or account number you submitted → no hits.

---

## 6. Known friction (not bugs)

| You'll notice | Why |
|---|---|
| Admin needs a hand-minted JWT | Admin is not a self-service role; no invite flow is in scope |
| OTP codes come from a file | No SMS provider in scope; the dev provider refuses to boot in production |
| `429` when testing quickly | Registration is capped at 5/min — correct behaviour |
| A crop defeats duplicate detection | Inherent to perceptual hashing; the threshold is tuned to avoid falsely accusing honest promoters |
| Offers need a funded campaign | Money is admin-recorded; there is no payment gateway in this MVP |
| No notifications arrive | In-app/email notifications are the deferred harden slice |
