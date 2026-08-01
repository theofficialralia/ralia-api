# Ralia — Backend Plan Delta (Algorithm Tranche)

| | |
|---|---|
| **Status** | Proposed — 2 Aug 2026 |
| **Extends** | [BACKEND_PLAN.md](BACKEND_PLAN.md) (phases B0–B9) |
| **Driven by** | [ALGORITHMS.md](ALGORITHMS.md), [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) |

B0–B9 delivered the thin loop + harden slices: schema, ledger, identity, profiles/reach, campaigns/pricing, matching skeleton, tracking, evidence/pHash, admin, gate pack. The algorithm decisions of 2 Aug add logic **beyond** that surface. This delta sequences only the new work.

Sizing: **S** ≤ 1d · **M** 2–3d · **L** 4–5d. Order is by dependency — each tranche assumes the ones above it.

## Prerequisite — real background workers `[infra, M]`

Several items below need scheduled/async execution: offer & delivery **timers**, **auto-reclaim** of expired slots, nightly **score recompute** (reliability/fatigue/proof-decay), the **Friday payout batch**, and **settlement reconciliation**. The BullMQ/Redis interface exists but is interface-only — stand up actual workers + a scheduler first. Everything in D2/D4/D6 depends on this.

## D1 — Reach & pricing upgrades `[extend B3/B4/B1, L]`

- Group reach on **active participants**; **unverified cap** (~2,000) and **proof staleness/decay** (~90d) — schema flags + a decay job. *(S)*
- **Objective/targeting multiplier table** in Platform rules; **reach-goal quote** + `projected_reach(b)` inverse for the budget↔reach slider (compute + API). *(M)*
- **Pro-rata pay + escrow cascade** — the load-bearing ledger change: charge promised, settle on delivered, refund the delta. Careful double-entry + property tests. *(L, highest-risk item in this delta)*

## D2 — Scoring engine `[extend B3/B5, M]`

- **Capability score** per role from required onboarding data, verified-dominant, with the admin-confirm step wired into the existing "under review" flow.
- **Trust evolution** (asymmetric event deltas), **reliability** (rolling+lifetime blend), **fatigue** (÷ weekly cap).
- Recompute job for reliability/fatigue; trust moves transactionally on each verdict/dispute event.
- Depends on: **onboarding-required gating** (Decision 7) landing in identity/profiles first.

## D3 — Matching v2 `[extend B5, M]`

- Re-weight the ranker (performance-weighted), add **capability** as gate + term, **right-sized reachFit**.
- **Supply-adaptive newbie gate** computed per-campaign at match time (needs the eligible-pool count + a high-stakes flag on campaigns).
- Depends on: D2 (scores must exist to rank on).

## D4 — Allocation v2 `[extend B5, L]`

- **Hybrid** ranked head-start → open free-to-air; **over-offer** with **atomic slot locking** (DB-level, concurrency-safe).
- **Accept window + delivery deadline** timers; **auto-reclaim** on expiry (worker).
- Open-phase claims still **eligible + stakes-capped**.
- Depends on: workers (prereq), D3 (ranking drives the head-start order).

## D5 — Evidence v2 `[extend B7/B8, M]`

- pHash near-match → **admin flag queue** (not auto-reject); **N-reject flag**.
- **View-count**: promoter-entered + OCR/admin cross-check (OCR is an external dependency — spike early).
- **Proof type by objective/role** (schema + submission validation).
- Feeds D1 pro-rata (delivered_ratio comes from the verified count).

## D6 — Payout v2 `[extend B1/B8, M]`

- **Release-on-approval** to promoter balance (pro-rata net); **withdrawal request → admin approve → Friday batch** (worker) → Paystack transfer.
- **Settlement reconciliation** — match escrow-in ledger entries to Paystack settlement reports; gate go-live on confirmed funds.
- Admin-adjustable flat min/max withdrawal.

## D7 — Transparency surfaces `[read APIs across modules, S–M]`

- Expose to each frontend the scores/status that affect them + "how to improve" hints: promoter Trust/Fit/capability tier + nudges; client assurance signals; admin the full picture. Mostly additive read-model fields.

---

## Critical path & risk

```
workers ─┬─ D1 (pro-rata escrow ← biggest ledger risk)
         ├─ D2 scoring ── D3 matching v2 ── D4 allocation v2
         ├─ D5 evidence v2 → feeds D1
         └─ D6 payout v2 → needs D1 + workers
D7 rides on top once the read models exist.
```

**Do first:** workers + D1 escrow (money correctness) and D2→D3 (make matching real).
**Highest risk:** D1 pro-rata escrow cascade (money), D4 atomic locking (concurrency), D5 OCR (external).
**Rough total:** ~one worker-week of infra + ~4–5 weeks of tranche work, solo, Mon–Sat.
