# Ralia — Pricing, Governing Rules & the Money

*A reference for the financial side of Ralia: what a campaign costs, how promoters are
paid, and the rules the platform enforces with money.*
*Audience: the product owner, finance, and anyone reviewing how the numbers work — plain
language first, with the exact figures and where they live in code.*

All amounts are Naira (₦). Internally every value is stored in **kobo** (minor units,
1 ₦ = 100 kobo) as integers, so nothing ever loses a fraction. The single source of
truth for the rates is the `rate_config` row in the database
([`prisma/schema.prisma`](../prisma/schema.prisma) → `model RateConfig`); an admin can
change them at runtime from Settings.

---

## 1. The two campaign categories

Every campaign is priced under one of two categories, decided by the promoter **role**
the campaign targets (`categoryForRole` in
[`src/common/pricing/pricing.ts`](../src/common/pricing/pricing.ts)):

| Category | Roles it covers | What the client is buying |
|---|---|---|
| **Distribution** | Distributor, Influencer | Reach — their post shared to real audiences |
| **Creation** | Creator, Participator | Made content / completed tasks (videos, reviews, sign-ups) |

Creation costs far more per view than Distribution, because the promoter is producing
something, not just resharing.

---

## 2. Governing rates (the current numbers)

These are the `rate_config` defaults. Both categories share the same shape — a **minimum
fee**, a **minimum of 4 promoters**, and **~1,000 reach per promoter** — and differ only
in price.

| Rule | Distribution | Creation / Participation |
|---|---|---|
| Rate per 1,000 verified views (RPM) | **₦3,750** | **₦25,000** |
| Reach per promoter (default) | **1,000** | **1,000** |
| Minimum promoters | **4** | **4** |
| **Minimum campaign fee (floor)** | **₦15,000** | **₦100,000** |

So the floors are simply `4 promoters × 1,000 reach × RPM`:
- Distribution: 4 × ₦3,750 = **₦15,000** → 4,000 reach
- Creation: 4 × ₦25,000 = **₦100,000** → 4,000 reach

A campaign can never be quoted below its category floor.

---

## 3. How a price becomes a campaign (price-driven quoting)

The client names an **exact budget**; the platform works backwards to how many promoters
that buys at the category rate. The price the client typed is authoritative and is **never
rounded or "snapped"** — only the promoter count rounds to a whole number (you can't book
4.3 people). This is `sizeFromPrice` / `quote()`
([`pricing.ts`](../src/common/pricing/pricing.ts),
[`campaigns.service.ts`](../src/modules/campaigns/campaigns.service.ts)).

Worked examples:
- **₦30,000 Distribution** → 8 promoters, ~8,000 target reach.
- **₦120,000 Creation** → ~4–5 creators, ~4,000–5,000 target reach.

Each quote stamps a **`targetReach`** on the campaign — the reach the client paid for. This
is the number the whole delivery engine works to meet (see §6).

---

## 4. How promoters get paid, and Ralia's cut

- **Split:** the promoter keeps **50%** of a slot's price; Ralia keeps **50%**
  (`take_rate = 0.50`). Tune with one number.
- **Pay is pro-rata on VERIFIED views**, not on what the promoter claims. The promoter
  enters a view count at submission (now **mandatory**); an admin verifies it before any
  money moves, and the fee scales to the verified figure.
- **Delivery threshold — 70%:** a post that delivers less than 70% of its promised reach
  is **rejected, not part-paid** — the promoter can resubmit. (`delivery_threshold_pct`.)
- **Over-delivery is capped:** beating the promised reach doesn't pay more than the slot
  was priced for.

The settlement maths lives in `settleDelivery` ([`pricing.ts`](../src/common/pricing/pricing.ts)).

### What changed here (recent)
Previously, when a promoter under-delivered, the shortfall was booked to Ralia's revenue
immediately. **Now the undelivered remainder stays in escrow** so the campaign can re-buy
that reach (§6). The accounting invariant is `fee + take + retained = gross` — escrow never
leaks a kobo. If the campaign ultimately can't re-deliver, that remainder is swept to Ralia
at the end (`retainCampaignRemainder`), so **total platform revenue is unchanged — only the
timing moved.** There is still **no client refund** for under-delivery; the platform retains it.

---

## 5. The money flow (accounts and movements)

Ralia is the bank in the middle. Balances are always derived from a double-entry ledger
([`src/modules/ledger`](../src/modules/ledger)) — there is no editable balance column.

```
Client pays (Paystack)
        │
        ▼
   CAMPAIGN_ESCROW ──(admin approves proof)──► PROMOTER_AVAILABLE  (the 50% fee, pro-rata)
        │                                   └─► RALIA_REVENUE       (the 50% take)
        │
        ├─(campaign rejected by admin)──────► CLIENT_WALLET         (full refund)
        └─(finalises short, no reopen)──────► RALIA_REVENUE         (undelivered remainder)

PROMOTER_AVAILABLE ──(withdrawal, admin-paid)──► BANK_CLEARING
```

Campaign lifecycle: **quote → pay → PENDING_APPROVAL → admin approve → LIVE** (or admin
reject → refunded & CANCELLED). Nothing goes live without an admin review, and the client
only ever hears about *verified*, approved work.

---

## 6. Reach-driven completion & auto-reopen (recent)

The manual view count now governs whether a campaign is done:

1. Every approved submission adds its **verified** reach to the campaign total.
2. A campaign is **complete only when Σ verified reach ≥ `targetReach`** (what the client paid for).
3. If it falls short and no work is still in flight, it **reopens slots** — funded from the
   escrow that under-deliveries left behind (§4), capped by the reach still owed and by the
   funds actually available — and keeps matching new promoters, **at no extra charge to the
   client**.
4. It only finalises when the target is met **or** the budget genuinely can't buy any more
   reach.

This replaced the old behaviour where a campaign could be marked "complete" while it had
quietly under-delivered. Logic lives in `approveSubmission`
([`src/modules/admin/admin.service.ts`](../src/modules/admin/admin.service.ts)) and the
allocation sweep ([`src/modules/allocation`](../src/modules/allocation)).

---

## 7. Other financial guardrails

| Rule | Value | Meaning |
|---|---|---|
| Take rate | **50%** | Ralia's cut of each slot |
| Delivery threshold | **70%** | Below this share of promised reach, a post is rejected |
| Unverified-reach cap | **2,000** | Reach a promoter can be credited before their channel is verified |
| Withdrawal minimum | **₦5,000** | Smallest payout a promoter can request |
| Proof validity | **90 days** | How long a proof screenshot stays usable |

---

## 8. Change log (governing rules & costing)

- **Category recalibration** (`migration 20260912...recalibrate_category_rates`):
  - Distribution RPM ₦3,000 → **₦3,750** per 1,000; default promoters 5 → **4**.
  - Creation RPM ₦500 → **₦25,000** per 1,000; reach/promoter 10,000 → **1,000**;
    default promoters 20 → **4**.
  - **Fixes the "budget overblows reach" bug:** a ₦100,000 Creation campaign used to
    promise ~200,000 reach; it now promises the intended ~4,000 (4 creators × 1,000).
  - Floors unchanged: **₦15,000** (Distribution), **₦100,000** (Creation).
- **Mandatory view count:** the promoter's manual view count is required at submission and
  drives pay and completion.
- **Settlement change:** under-delivery remainder is retained in escrow (to fund reopens)
  and only booked to revenue at finalisation — total revenue unchanged.
- **Reach-driven completion + auto-reopen:** campaigns run until verified reach meets the
  paid-for `targetReach`, reopening slots from retained escrow when short.

> The live numbers always come from `rate_config`; the tables above reflect the current
> defaults. If an admin changes a rate in Settings, this doc's figures should be updated to
> match.
