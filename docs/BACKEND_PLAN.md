# Ralia MVP — Backend Build Plan

| | |
|---|---|
| **Reference** | DSD-RALIA-BEP-R02 |
| **Revision** | R1.0 — Internal |
| **Basis** | Claude Code Handoff (DSD-RALIA-CC-R02) §4/§6 frozen contract, §9 build order, §10 definition of done |
| **Companion to** | Modules, Phases & Milestones (DSD-RALIA-PLAN-R02) |
| **Start** | Fri 17 July 2026 |
| **Working assumption** | Solo, Mon–Sat, Sundays off |

This plan sequences the backend (M1–M6 plus admin endpoints) into nine phases and splits each into a **thin** slice and a **harden** slice. The thin slices, taken together, are the shortest path to the Phase-2 payment gate. The harden slices are everything else the frozen contract asks for.

Build in the order given. Do not start a phase before the one above it is done.

---

## 01 The gate math — read this before anything else

The engagement releases ₦210,000 on "completion of phase 2," interpreted in the internal plan as *the core loop demonstrably works*, expected end of week 2 — **Fri 31 July**. Costing the work honestly against the handoff's own definition of done:

| Approach | Demonstrable loop | Full contract surface |
|---|---|---|
| Sequential, each phase complete before the next | ~Sat 15 Aug | ~Sat 15 Aug |
| **Thin loop first, then harden** | **~Thu 6 Aug** | ~Tue 18 Aug |

Thin-first pulls the gate evidence in by **eight working days** and pushes full completion out by **two**. That is the trade, and it is worth taking on an engagement where 40% of the fee sits behind handover.

Neither approach hits 31 July. An earlier estimate of "~31 July for the thin loop" was optimistic; costed phase by phase it is ~6 Aug, about one week late rather than two. Say this to Esele early, in writing, with the revised date — a gate that slips with notice is a scheduling fact, and a gate that slips silently is a dispute.

**The thin loop is not a compromise on rigour.** All seven definition-of-done criteria in handoff §10 land inside it (see §04 below). What defers to hardening is *breadth of surface*, not *quality of core*. Nothing in the harden column is load-bearing for the sentence the gate pays on.

Two phases have no thin slice and are built complete: **B0 Foundation** and **B1 Ledger**. A schema retrofitted later is a migration; a ledger retrofitted later is wrong money. The handoff says so twice and it is right both times.

---

## 02 Phase table

| # | Phase | Thin | Harden | Thin lands |
|---|---|--:|--:|---|
| B0 | Foundation — schema, seed, environments, CI | 3d | — | Mon 20 Jul |
| B1 | Ledger — accounts, postings, idempotency | 3d | — | Wed 22 Jul |
| B2 | Identity — register, OTP, login, roles, consent | 1.5d | 1d | Fri 24 Jul |
| B3 | Profiles, channels, effective reach | 1.5d | 1.5d | Sat 25 Jul |
| B4 | Campaigns, assets, targeting, pricing | 2d | 2.5d | Tue 28 Jul |
| B5 | Matching, offers, assignments | 2d | 1.5d | Thu 30 Jul |
| B6 | Tracking service | 0.5d | 1d | Fri 31 Jul |
| B7 | Evidence — submission, phash, verdict | 1.5d | 0.5d | Mon 3 Aug |
| B8 | Admin endpoints | 1.5d | 1d | Wed 5 Aug |
| B9 | Gate pack — collection, capture | 1d | 1.5d | **Thu 6 Aug** |

Harden slices run B2→B9 in the same order from Fri 7 Aug, landing ~Tue 18 Aug.

---

## 03 Phases in detail

### B0 — Foundation · complete, no thin slice · Days 1–3

Prisma schema covering **all** of handoff §4 — every table, every enum, every column, including fields the thin API will not yet expose. Writing the full schema now costs hours; migrating into it later costs days and risks live data.

- Docker Compose: postgres, redis, minio, mailpit. One-command bring-up.
- Seed: 2 clients, ~40 promoters across every platform, 3 campaigns spanning every state.
- CI: a commit deploys to staging automatically.
- `.env.example` complete. No secret in the repo.
- **Swagger at `/docs`**, pulled forward from B9. The spec is generated from the code, so every phase decorates its DTOs as it writes them; deferring it would mean walking back through B2–B8 to annotate retroactively. It also makes the §6 contract browsable for the design and UI tracks, which is the whole premise of §03. (B9 still owns the *collection that demonstrates the loop* — a different artefact from the spec.)

**Done when:** a clean checkout reaches a running, seeded API in one command, and `migrate down` returns to zero without hand-holding. Migrations are expand-then-contract from the first one — never a migration that breaks the running version.

### B1 — Ledger · complete, no thin slice · Days 4–6

Accounts, balanced postings, all money access via commands. **No balance column exists anywhere** — balances are `SUM(ledger_entries)`, always. `Idempotency-Key` middleware rejects any money mutation arriving without one.

**Done when:**
- **Property test** passes over thousands of random fund/approve/reject/withdraw/refund sequences: every transaction balances, no account that must be non-negative goes negative.
- **Idempotency test** passes: replaying any money mutation five times moves the balance once.

Both are gate evidence in their own right. Green them here and they stay green.

### B2 — Identity · Days 7–8 (thin) · Day 20 (harden)

**Thin:** register as client and promoter; OTP via a pluggable provider (console in dev); login, refresh, logout; roles; sessions; consent rows written at signup; a basic rate limit on OTP and login.

**Harden:** forgot-password; consent revocation endpoints and exclusion of revoked fields from targeting; rate-limit tuning; session-expiry preserving unsaved draft data; a real SMS/WhatsApp provider adapter behind the same interface.

**Done when (thin):** both account types register, verify, log in and reach an authed endpoint, with a consent row per sensitive-field purpose.

### B3 — Profiles, channels, reach · Days 9–10 (thin) · Days 21–22 (harden)

**Thin:** only the questionnaire fields matching actually filters on — `status`, `trust_score`, `location_state`, `dob`/`age`, `languages_spoken`, `preferred_categories`, `max_campaigns_per_week`. Channels CRUD with `effective_reach` computed server-side from the §5.1 factors and **never** accepted from the client. Bank account storage, encrypted at rest with a key separate from the DB credential — the withdrawal leg needs it.

**Harden:** the rest of the Prolific-style field set (education, qualifications, field of study, occupation, industry, employment status, countries travelled, religion, country of residence/birth, hobbies, camera comfort, skills, device info); partial-save resumability across all steps; the per-field "why this helps you earn" copy contract.

The schema holds every column from B0 — thin narrows the *API surface*, not the data model.

**Done when (thin):** `POST /channels` returns an `effective_reach` a unit test confirms against the factor table, and a promoter reaches ACTIVE with enough profile to be matched.

### B4 — Campaigns and pricing · Days 11–12 (thin) · Days 23–25 (harden)

**Thin:** draft create; single-file asset upload to minio; targeting; slots; `rate_config` as a single active row; the quote endpoint returning price, estimated reach and promoter count. The campaign **stores the price it was quoted** — that is a data decision, not a feature, so it belongs in thin. Lifecycle only as far as the loop needs: Draft → PendingApproval → AwaitingFunding → ConfirmingPayment → Live.

**Harden:** the `needs_creative` / request-creative path; multi-file upload and compression; pause/resume; Ended / Fulfilled / Settled and the refund line; the analytics endpoint; the regression test proving a `rate_config` change never reprices a live campaign.

**Done when (thin):** a campaign goes draft → assets → targeting → quote with a deterministic price matching the §5.2 formula by hand.

### B5 — Matching, offers, assignments · Days 13–14 (thin) · Days 26–27 (harden)

**Thin:** the hard SQL filter in full (every clause — this is what is load-bearing); the candidates endpoint returning the filtered list; admin-sent offers; accept/decline; slot reservation under `SELECT … FOR UPDATE SKIP LOCKED`.

**Harden:** the §5.3 ranking score (`reachFit`, `categoryFit`, trust, reliability, fatigue) — thin returns the filtered list ordered by `effective_reach`, since ranking is admin display and the filter is correctness; the offer-expiry sweeper; decline/expiry releasing the slot; offer withdrawal; direct influencer assignment.

**Done when (thin):** **concurrency test** passes — N simultaneous accepts on an M-slot campaign fill exactly M — and each filter clause has an independent test.

### B6 — Tracking · Day 15 (thin) · Day 28 (harden)

**Thin:** `GET /r/:token` records a click and 302s to the destination. A direct write is fine at MVP volume.

**Harden:** the buffer and batch flush; bot filtering by UA; per-IP-hash rate limiting; confirming the redirect still serves while the main API is under load.

The loop needs the click to *land*, not to be fast. Standalone module — buildable any time after B0 if a phase ahead of it stalls.

### B7 — Evidence · Days 16–17 (thin) · Day 29 (harden)

**Thin:** multipart submission; store the artifact; compute a perceptual hash on receipt; compare against all existing `proof_artifacts`; set `auto_flag` and link `reuse_of_id` on a match. **No auto-approval** — every submission reaches the admin queue; the flag only surfaces risk.

**Harden:** hamming-distance threshold tuning; resumable upload; file scanning; private storage served via short-lived signed URLs.

**Done when (thin):** **duplicate-screenshot test** passes — the same image on a second submission flags it and links the original.

### B8 — Admin endpoints · Days 18–19 (thin) · Day 30 (harden)

**Thin:** approve user; approve campaign; record funding; decide submission (reason mandatory on reject); approve and record withdrawal. `audit_log` on every one, with before/after.

Define **two distinct permissions from the start** — reviewing evidence, and recording money — even though one person holds both at launch. Handoff §7 asks for them to be separable; separating them now is free and separating them later is a refactor.

**Harden:** suspend user; the RBAC roles that consume those two permissions; queue filtering and pagination.

**Done when (thin):** approving a submission posts fee-to-promoter and take-to-revenue as **one** balanced transaction, and every money- or score-affecting write has an audit row.

### B9 — Gate pack · Day 20 (thin) · Days 31–32 (harden)

**Thin:** the Postman or OpenAPI collection that runs the entire loop, and a dated screen capture of it running.

**Harden:** notifications — in-app and email via Resend, firing on offer / approval / payment; the WhatsApp adapter behind the same interface, enabled only if templates approve.

**Done when (thin):** register client + promoter → complete profile + channel → create + fund campaign → generate candidates → send offer → accept → click the tracking link → submit proof → admin approves → ledger pays the promoter → promoter withdraws → admin records payout. Green, end to end, recorded, dated.

**This is the Phase-2 gate. Send the capture the day it passes.**

---

## 04 Definition of done — where each criterion lands

All seven handoff §10 criteria are satisfied by the thin loop. This is the argument for thin-first, in one table.

| §10 criterion | Phase | Slice |
|---|---|---|
| Loop runs end-to-end via the API | B9 | Thin |
| Ledger property test passes | B1 | Complete |
| Idempotency test passes | B1 | Complete |
| Concurrency test passes | B5 | Thin |
| Duplicate-screenshot test passes | B7 | Thin |
| Seed + one-command bring-up | B0 | Complete |
| No secret in repo; `.env.example`; migrations clean forward and back | B0 | Complete |

---

## 05 Contract decisions

Each was a contradiction between the handoff's §4 data model and the Screen Flows & States document, which the schema could not encode both of. Decided 16 July 2026 and now encoded in `prisma/schema.prisma`.

1. **Campaign states — RESOLVED.** `DRAFT | QUOTED | PENDING_APPROVAL | REJECTED | CONFIRMING_PAYMENT | LIVE | PAUSED | ENDED | FULFILLED | SETTLED | CANCELLED`. The flows list won: it has a designed `ConfirmingPayment` screen that §4's `FUNDING` doesn't cover. `CANCELLED` added back — a client must be able to kill a draft. `SETTLED` retained for the escrow-refund line.
2. **Promoter status — RESOLVED.** Split across two tables. `users.status` = `PENDING | ACTIVE | SUSPENDED | BANNED` (the account). `promoter_profiles.status` = `PROFILE_INCOMPLETE | AWAITING_APPROVAL | REJECTED | ACTIVE` (the approval track, which matching filters on). A suspended account and an unapproved promoter are different facts.
3. **Withdrawal minimum — RESOLVED.** ₦5,000, as `rate_config.withdrawal_minimum_minor = 500000`. Payouts are manual admin bank transfers, so each withdrawal costs admin time.

### Still open

4. **`trust_score` has no mover.** Matching filters on `trust_score >= 30` and ranks on `trust/100`, `reliability` and `fatigue`. Nothing in any document says what writes them. Fatigue and reliability are derivable from assignments; trust score is not. Admin-set, or a formula? The column exists with `default 50`, so this blocks **B5**, not B0.
5. **Bank account-name confirmation.** The bank-details screen wants account-name confirmation, which implies a bank resolution API and brushes against "no payment gateway in scope." Either it is a name-lookup-only integration or the screen falls back to plain entry. Blocks **B3 thin**.

---

## 06 The scope line

Everything in handoff §11 and internal plan §7 is out and stays out: payment gateway, card checkout, automated escrow or payouts, learning reach score, auto-sent offers, persistence re-checks, appeals, fraud console, creator draft-revision subsystem, influencer marketplace, chat, referrals, gamification, native apps, multi-currency, multi-language, analytics beyond the four SOW metrics.

If a phase above seems to need one of them, it does not. Check §11 before building it. Anything genuinely additional is a change order at ₦250k/week, agreed by email before work starts.

When in doubt, build the smaller thing.
