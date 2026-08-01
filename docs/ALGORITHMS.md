# Ralia — Business Logic Algorithms

| | |
|---|---|
| **Status** | Settled — 2 Aug 2026 |
| **Companion to** | [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md), [BACKEND_PLAN_DELTA.md](BACKEND_PLAN_DELTA.md) |

The ten vital algorithms, each with its concrete formula and tunable knobs. This is the source of truth to build against.

**Legend:** `[built]` exists today · `[extend]` built but changing · `[new]` not yet built · `[knob]` admin-tunable in Platform rules. Default constants are starting values for calibration, not fixed law.

## Cross-cutting principles

- **One verification spine** — self `0.6×` / screenshot `1.0×` / insights `1.15×` — used identically in reach *and* capability.
- **Everything settles on *delivered* reach** (pro-rata), across client, promoter, and Ralia's cut.
- **Transparency** — each user sees the scores/status that affect them, plus how to improve them (see §7).

---

## 1. Effective Reach `[built, extend]`

```
eff_reach = round(basis × platform_factor × verification_factor)
```

- **basis** = *active participants* for groups/communities; claimed followers otherwise.
- **platform_factor** `[knob]`: WhatsApp Status .30 · WhatsApp group .20 · Telegram .20 · TikTok .12 · LinkedIn .12 · Instagram .10 · Facebook .10 · X .05 · offline .15
- **verification_factor**: self-reported 0.6 · screenshot 1.0 · insights 1.15
- **Unverified cap** `[new]`: while self-reported, per-channel `eff_reach` is capped at `~2,000` `[knob]` until proof lifts it.
- **Proof staleness** `[new]`: screenshot/insights proof valid `~90 days` `[knob]`, then decays toward self-reported until refreshed.
- **Channel selection**: a campaign uses the promoter's **best channel on that campaign's platform**.

## 2. Pricing / Quote `[built, extend]`

```
slot_price          = (eff_reach / 1000) × RPM × objective_mult × targeting_mult   [knob: RPM, mults]
promoter_fee_ceiling = slot_price × (1 − take_rate)                                 take_rate = 0.30 [knob]
```

**Quote — reach-goal anchored** `[new]`. Client enters a target reach `R_goal`:
```
recommended_budget = (R_goal / 1000) × RPM × objective_mult × targeting_mult   (capped at eligible-pool max-reach cost)
floor              = max(min_campaign_fund, one slot_price)
projected_reach(b) = 1000 × b / (RPM × objective_mult × targeting_mult)         (capped at pool max)
```
Budget and reach are inverses — the slider moves `b` in `[floor, cap]` and reach updates live.

**Payment — pro-rata with delivery floor** `[new]`:
```
delivered_ratio = min(actual_views / promised_views, 1)
if actual_views < τ × promised_views:   reject / resubmit          τ ≈ 0.70 [knob]
else:                                    promoter gets fee_ceiling × delivered_ratio
```

**Escrow cascade** `[new]`. Client charged the *promised* amount into escrow at funding. On each verified delivery:
```
client billed  = slot_price × delivered_ratio
Ralia take     = client_billed × take_rate
promoter paid  = client_billed − Ralia_take
client refund  = slot_price × (1 − delivered_ratio)     (under-delivery + unfilled slots → wallet)
```
Conserves in the double-entry ledger; everyone settles on delivered reach.

## 3. Capability Score — per role `[new]`

`0–100` per role a promoter holds. **Verified inputs dominate**; score is **admin-confirmed at the "under review" step**; used as an **eligibility gate + a ranking term**. Starting compositions `[knob]`:

| Role | Composition |
|---|---|
| **Distributor** | verified eff_reach `.5` + posting frequency `.2` + recent-post proof `.3` |
| **Creator** | admin-rated samples `.5` + content breadth `.15` + equipment `.15` + camera comfort `.1` + turnaround `.1` |
| **Participator** | task breadth `.3` + device coverage `.3` + multi-step willingness `.2` + real/aged accounts `.2` |

## 4. Trust Score `[built default, rules new]`

`0–100`, starts at `50`. **Asymmetric** evolution — reputation earned slowly, lost quickly `[knob]`:

| Event | Δ |
|---|--:|
| On-time verified delivery | +2 |
| Late verified delivery | +0.5 |
| Rejected submission | −6 |
| Upheld dispute / missed-deadline no-show | −10 |

Clamp to `[0, 100]`. Matching hard-filter requires `trust ≥ 30`.

## 5. Reliability Score `[new]`

```
reliability = 0.6 × rolling_ontime_rate(60d) + 0.4 × lifetime_completion_rate     [knob]
```
Rolling rewards recent delivery; lifetime rewards loyalty/longevity. No history → `0.5`.

## 6. Fatigue `[new]`

```
fatigue = min(active_campaigns_7d / max_campaigns_per_week, 1)
```
Relative to the promoter's own stated weekly cap.

## 7. Matching / Ranking `[built skeleton, re-weight]`

**Hard filter:** role-eligible · `capability ≥ floor` `[knob]` · platform match · geo/age/language · `status = ACTIVE` · `trust ≥ 30`.

**Performance-weighted rank** (proven signals 55% / audience fit 45%):
```
score = 0.20·capability + 0.20·(trust/100) + 0.15·reliability
      + 0.25·reachFit   + 0.20·categoryFit − 0.15·fatigue
```
- **reachFit = right-sized** — fits the remaining slot need, not simply the largest reach.
- **Supply-adaptive newbie gate** `[new]`, decided **per-campaign at match time**:
  ```
  supply_ratio = eligible_qualified / slots_remaining
  if supply_ratio ≥ ~3× [knob]:   gate unproven promoters out of high-stakes campaigns
  else:                            open access to all eligible
  ```
- **Transparency**: promoters see Trust/100, per-offer Fit %, capability tier, and concrete "do X to raise it" nudges.

## 8. Offer Allocation `[new]`

**Hybrid, two-phase:**
1. **Ranked head-start** — top-fit eligible promoters get an exclusive accept window (the "Expires in" timer `[knob]`).
2. **Open free-to-air** — unfilled slots open to **eligible + stakes-capped** promoters, first-come.

- **Over-offer** to `~1.5×` remaining slots `[knob]` with **atomic slot locking** (concurrency-safe decrement) — surplus offers auto-expire.
- Accepted slots carry a **delivery deadline**; miss → **auto-reclaim** to pool + reliability ding.

## 9. Evidence Verification `[built pHash, extend]`

- **pHash** near-match (Hamming ≤ `~10/64` `[knob]`) or edit signs → **flag to admin** (not auto-reject).
- **View count** → promoter enters, OCR/admin cross-checks against the screenshot; mismatch → flag. Feeds §2 pro-rata.
- **N rejected submissions** (default 2 `[knob]`) → **flag for admin, keep active**.
- **Required proof by objective/role**: view-count screenshot for reach · app-store/receipt/confirmation for participator tasks · published-content link for creator.

## 10. Payout & Escrow `[built ledger, extend]`

- **Release on verified approval** → promoter available balance (pro-rata net per §2; take to Ralia; delta refund to client).
- **Withdrawal**: request (`≥ min 5,000`, `≤ max 20,000` — flat but admin-adjustable `[knob]`, `≤ balance`) → **admin approve** → **Friday batch** → Paystack transfer.
- **Reconcile** ledger escrow-in against **Paystack settlement** before a campaign goes live (webhook ≠ settled funds).
