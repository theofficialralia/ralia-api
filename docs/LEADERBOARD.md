# Ralia — Leaderboard & Tiers (Design Spec)

*How Ralia motivates promoters with points and rank, and how those points later gate
access to higher-earning campaigns through tiers.*
*Audience: engineering + product. Reference-grade; written to be built from.*

Status: **design / not yet built.** This spec defines the data model, the point rules,
the ranking pipeline, the tier hooks, and a phased build checklist.

---

## 1. Why a leaderboard (and why not cash)

We considered paying promoters a cash bonus for over-delivery. On a fixed campaign
budget that only works when slots go unfilled — a fully-subscribed campaign has no
spare money, so the reward is inconsistent and fights our margin (see
[PRICING-AND-FINANCE.md](./PRICING-AND-FINANCE.md) and the over-delivery discussion).

A **points + tier** system sidesteps that entirely:

- **Non-monetary** — no budget or margin impact, no fixed-price conflict.
- **Rewards effort/over-delivery** — the eager promoter earns points and climbs, and
  (via tiers) unlocks campaigns with higher earnings. The reward is *future access*,
  not this campaign's cash.
- **Reuses what we already track** — trust, reliability, on-time/late/no-show,
  completed deliveries, verified reach. Points are emitted from the **same hooks** that
  already record these (`ScoringService.recordDeliveryOutcome`, `approveSubmission`).

**Principal risks & mitigations**
- *Gaming* → points come **only** from admin-verified events, are **idempotent**, and
  carry **penalties** for no-shows/rejections/duplicates; per-campaign/day **caps**.
- *Whales dominate* → reward **relative** delivery (`verified ÷ promised`) heavily, cap
  the absolute-reach component, apply diminishing returns.
- *Discouragement / frozen top* → **seasons** (periodic reset) plus a lifetime board;
  show personal progress, not only the global top.

---

## 2. Core concepts

| Concept | What it is |
|---|---|
| **Point event** | One append-only ledger row per scored action (may be negative). Source of truth. |
| **Promoter score** | A cached rollup per promoter (lifetime, season, rolling-90, rank, tier, streak). |
| **Season** | A reset period (default monthly). The season board is what keeps competition live. |
| **Scope** | A board slice: global, by state, by category, by role. |
| **Tier** | A band (Bronze→Platinum) derived from sustained points + a reliability floor. Gates campaign access. |
| **Snapshot** | A frozen ranked standing per season/scope, for cheap reads and history. |

The **point event ledger is authoritative**; every aggregate (score, rank, tier,
snapshot) is derived from it and can be rebuilt.

---

## 3. What earns points (event catalog)

Every award ties to a **verified** outcome. Default values are **configurable** (see §8);
the numbers below are starting points, not law.

| Type | When | Default points | Notes |
|---|---|--:|---|
| `DELIVERY_COMPLETED` | Submission approved | **+50** | The base "you did the job" award. |
| `DELIVERED_ON_TIME` | Approved by its deadline (`deliveredOnTime`) | **+20** | Reuses the existing flag. |
| `OVER_DELIVERY` | `verified > promised` | **+ up to 60** | Scaled by ratio — see §4. This is the effort reward. |
| `QUALITY_CLEAN` | Approved first try, no duplicate flag | **+15** | Rewards clean proof. |
| `STREAK_BONUS` | Nth consecutive on-time delivery | **+5 × streak (cap 50)** | Resets on a miss/rejection. |
| `BREADTH_BONUS` | First delivery in a new category/role this season | **+10** | Encourages range. |
| `MILESTONE` | Profile complete · channel verified · first campaign | **+25 each (once)** | Onboarding nudges. |
| `PENALTY_NO_SHOW` | Missed deadline / reclaimed | **−40** | From the reclaim sweep. |
| `PENALTY_REJECTED` | Submission rejected | **−20** | Discourages junk proof. |
| `PENALTY_DUPLICATE` | Duplicate screenshot confirmed | **−30** | Anti-fraud. |
| `REVERSAL` | A prior award's source was reversed/charged back | negative of the original | Keeps the ledger honest. |
| `ADJUSTMENT` | Manual admin correction | any | Audited; capability-gated. |

**Difficulty multiplier** (applied to `DELIVERY_COMPLETED` + `OVER_DELIVERY`): harder
work is worth more. Reuse the campaign objective/role — e.g. Creation ×1.5,
Distribution ×1.0 (configurable, mirrors the pricing multipliers).

---

## 4. Over-delivery & normalization (the anti-whale maths)

The over-delivery award rewards **relative** performance so a small promoter who
over-performs can out-earn a big one who coasts:

```
ratio          = verified / promised            (clamped to [1, OVER_CAP], default OVER_CAP = 3)
over_delivery  = OVER_BASE × (ratio − 1)         (default OVER_BASE = 30 → +30 at 2×, +60 at 3×)
```

- **Relative, not absolute** — points come from *ratio to promise*, not raw views, so a
  1,000-slot promoter hitting 3,000 scores the same over-delivery as a 100k-slot
  promoter hitting 300k. Audience size doesn't auto-win.
- **Capped** (`OVER_CAP`) so one viral post can't run away.
- Optional **small absolute-reach component** (points per 1,000 verified views, capped
  per campaign) if we decide big genuine reach deserves *some* extra — off by default.
- **Diminishing returns** and a **per-campaign points cap** bound farming.

---

## 5. Periods, decay, and the three numbers

Each promoter carries three totals, all derived from the ledger:

- **`lifetimePoints`** — all-time cred (never resets). Drives all-time board + badges.
- **`seasonPoints`** — resets each season (default **monthly**). Drives the live board;
  gives newcomers a fair shot.
- **`rolling90Points`** — points in the trailing 90 days. The **stable** metric **tiers**
  key off, so a tier reflects *sustained current* performance, not seniority or a spike.

---

## 6. Ranking & boards

- **Rank** is computed **per season, per scope**; tie-break by `reliability` then recency.
- **Scopes**: `GLOBAL`, `STATE:<code>`, `CATEGORY:<name>`, `ROLE:<role>`.
- **Compute strategy** (scales, cheap reads):
  1. A **nightly job** recomputes ranks + tiers and writes `LeaderboardSnapshot` rows per
     season/scope.
  2. A **light per-event update** refreshes just the acting promoter's `PromoterScore`
     (points + provisional rank) so their own card feels live.
  3. Reads serve from `PromoterScore` (self) and `LeaderboardSnapshot` (boards) — never a
     full re-sort on request.

---

## 7. Data model (Prisma)

New enums, tables, and two columns on existing models. Conventions match the codebase
(`uuid` ids, snake_case `@map`, `Decimal`, explicit indexes).

```prisma
enum PointEventType {
  DELIVERY_COMPLETED
  DELIVERED_ON_TIME
  OVER_DELIVERY
  QUALITY_CLEAN
  STREAK_BONUS
  BREADTH_BONUS
  MILESTONE
  PENALTY_NO_SHOW
  PENALTY_REJECTED
  PENALTY_DUPLICATE
  REVERSAL
  ADJUSTMENT
}

enum PromoterTier {
  BRONZE
  SILVER
  GOLD
  PLATINUM
}

/// Append-only points ledger — the source of truth for every board and tier.
model PointEvent {
  id           String         @id @default(uuid()) @db.Uuid
  promoterId   String         @map("promoter_id") @db.Uuid
  type         PointEventType
  points       Int            // may be negative
  // Source that generated it (for audit, reversal, and idempotency).
  submissionId String?        @map("submission_id") @db.Uuid
  assignmentId String?        @map("assignment_id") @db.Uuid
  campaignId   String?        @map("campaign_id")   @db.Uuid
  // One source event yields at most one award of a given type.
  dedupeKey    String         @unique @map("dedupe_key")
  seasonKey    String         @map("season_key")    // e.g. "2026-09"
  metadata     Json?
  occurredAt   DateTime       @map("occurred_at")
  createdAt    DateTime       @default(now()) @map("created_at")

  promoter User @relation(fields: [promoterId], references: [id], onDelete: Cascade)

  @@index([promoterId, seasonKey])
  @@index([seasonKey, type])
  @@map("point_events")
}

/// Cached rollup per promoter — derived from PointEvent, refreshed by the scheduler
/// and by a light per-event update.
model PromoterScore {
  promoterId      String       @id @map("promoter_id") @db.Uuid
  lifetimePoints  Int          @default(0) @map("lifetime_points")
  seasonKey       String       @map("season_key")
  seasonPoints    Int          @default(0) @map("season_points")
  rolling90Points Int          @default(0) @map("rolling_90_points")
  rank            Int?         // within the current season, GLOBAL scope
  tier            PromoterTier @default(BRONZE)
  streak          Int          @default(0) @map("streak") // consecutive on-time
  updatedAt       DateTime     @updatedAt @map("updated_at")

  promoter User @relation(fields: [promoterId], references: [id], onDelete: Cascade)

  @@index([seasonKey, seasonPoints])
  @@index([tier])
  @@map("promoter_scores")
}

/// Frozen standings per season + scope, for cheap board reads and history.
model LeaderboardSnapshot {
  id          String   @id @default(uuid()) @db.Uuid
  seasonKey   String   @map("season_key")
  scope       String   @default("GLOBAL") // GLOBAL | STATE:<code> | CATEGORY:<name> | ROLE:<role>
  promoterId  String   @map("promoter_id") @db.Uuid
  rank        Int
  points      Int
  generatedAt DateTime @default(now()) @map("generated_at")

  @@index([seasonKey, scope, rank])
  @@map("leaderboard_snapshots")
}

/// Tunable rules (single active row, mirrors rate_config). Admin-editable, no deploy.
model LeaderboardConfig {
  id                 String   @id @default(uuid()) @db.Uuid
  isActive           Boolean  @default(true) @map("is_active")
  // Point values (see §3) …
  ptsDeliveryCompleted Int    @default(50)  @map("pts_delivery_completed")
  ptsOnTime            Int    @default(20)  @map("pts_on_time")
  ptsQualityClean      Int    @default(15)  @map("pts_quality_clean")
  overBase             Int    @default(30)  @map("over_base")     // §4
  overCapRatio         Int    @default(3)   @map("over_cap_ratio")
  penaltyNoShow        Int    @default(40)  @map("penalty_no_show")
  penaltyRejected      Int    @default(20)  @map("penalty_rejected")
  penaltyDuplicate     Int    @default(30)  @map("penalty_duplicate")
  perCampaignPointCap  Int    @default(150) @map("per_campaign_point_cap")
  // Difficulty multipliers as hundredths (100 = ×1.0), like the pricing multipliers.
  multCreationHundredths     Int @default(150) @map("mult_creation_hundredths")
  multDistributionHundredths Int @default(100) @map("mult_distribution_hundredths")
  // Season length in days (0 = never resets).
  seasonLengthDays     Int    @default(30)  @map("season_length_days")
  // Tier thresholds on rolling-90 points (see §9).
  tierSilverAt         Int    @default(300)  @map("tier_silver_at")
  tierGoldAt           Int    @default(800)  @map("tier_gold_at")
  tierPlatinumAt       Int    @default(2000) @map("tier_platinum_at")
  // Reliability floor a promoter must hold to sit in Gold/Platinum (0–1).
  tierReliabilityFloor Decimal @default(0.80) @map("tier_reliability_floor") @db.Decimal(4, 3)
  createdAt            DateTime @default(now()) @map("created_at")
  updatedAt            DateTime @updatedAt @map("updated_at")

  @@map("leaderboard_config")
}
```

**Two additions to existing models:**

```prisma
// PromoterProfile — cache the current tier here too, so matching filters cheaply
// without a join to promoter_scores (kept in sync by the scoring hooks).
tier PromoterTier @default(BRONZE) @map("tier")

// Campaign — optional access gate (see §9).
minTier PromoterTier? @map("min_tier")
```

---

## 8. Integrity, config, and reversal

- **Idempotent**: every award has a `dedupeKey` (`<type>:<sourceId>`); a replayed hook
  never double-awards (same pattern as the notification/ledger dedupe keys).
- **Reversal**: if a submission is later rejected/reversed, emit a `REVERSAL` of the
  original points rather than deleting — the ledger stays append-only and auditable.
- **Caps**: `perCampaignPointCap` and a daily cap bound farming.
- **Config**: all values live in `leaderboard_config` (one active row), editable from the
  admin Settings screen — same mechanism as `rate_config`.
- **Admin adjustments** are `ADJUSTMENT` events, gated by an admin capability and audited.

---

## 9. Tier hooks (the future gating)

Tiers are just thresholds on a **stable** metric plus a reliability floor, and one filter
in matching. Deliberately small, given the points model above.

**Derivation** (recomputed by the nightly job, cached on `PromoterScore.tier` and mirrored
to `PromoterProfile.tier`):

```
tier = PLATINUM if rolling90 ≥ tierPlatinumAt and reliability ≥ tierReliabilityFloor
     = GOLD     if rolling90 ≥ tierGoldAt     and reliability ≥ tierReliabilityFloor
     = SILVER   if rolling90 ≥ tierSilverAt
     = BRONZE   otherwise
```

Using **rolling-90** (not lifetime, not rank) means a tier reflects *sustained current*
performance; a promoter must keep delivering to hold it (natural demotion with a grace
period — don't demote on a single quiet week).

**The gate** — a campaign may set `min_tier`. Matching eligibility then excludes promoters
below it. This drops in exactly where the existing trust floor lives:

```ts
// buildEligibility(filters, rate.minTrustScore) already filters promoterProfile.
// Add, when campaign.minTier is set:
//   profileWhere.tier = { in: tiersAtOrAbove(campaign.minTier) }
```

**Other tier perks** (later, all config-driven): higher `maxCampaignsPerWeek`, a ranking
boost in matching, faster payout windows, early access to new campaigns.

---

## 10. API surface (sketch)

Promoter app:
- `GET /v1/leaderboard?scope=GLOBAL&season=current` → top N + the caller's own row.
- `GET /v1/promoters/me/score` → points, season/lifetime/rolling, rank, tier, streak,
  progress to next tier, and the point breakdown ("how you earned it").

Admin app:
- `GET /v1/admin/leaderboard/config` / `PATCH …` → tune values (Settings screen).
- `POST /v1/admin/promoters/:id/points` → an `ADJUSTMENT` (capability-gated, audited).

---

## 11. Implementation checklist

### Phase 0 — Foundations (data + config) ✅ done
- [x] Add `PointEventType`, `PromoterTier` enums; `point_events`, `promoter_scores`,
      `leaderboard_snapshots`, `leaderboard_config` tables; `PromoterProfile.tier` and
      `Campaign.minTier` columns. Migration (`20260921000000_add_leaderboard_foundations`)
      + seeds one `leaderboard_config` row.
- [x] `PointsService.award(input, tx)` — idempotent insert into `point_events`
      (dedupeKey), mirroring `NotificationService.create`. `LeaderboardModule` (global).
- [x] `LeaderboardConfigService.getActive()` / `currentSeasonKey()`.
- [x] `seasonKeyFor(date, seasonLengthDays)` helper (fixed-length seasons from a stable
      epoch → `S{n}`, or `ALL` when length ≤ 0). Specs cover award idempotency, tx
      enlistment, and season bucketing.

### Phase 1 — Earn points from existing hooks
- [ ] Emit awards from `approveSubmission`: `DELIVERY_COMPLETED`, `DELIVERED_ON_TIME`,
      `OVER_DELIVERY` (§4), `QUALITY_CLEAN`, `STREAK_BONUS`, difficulty multiplier,
      per-campaign cap. Same tx as settlement.
- [ ] Emit penalties from the reclaim sweep + `rejectSubmission`: `PENALTY_NO_SHOW`,
      `PENALTY_REJECTED`, `PENALTY_DUPLICATE`.
- [ ] Emit `MILESTONE` awards from onboarding / channel verification / first campaign.
- [ ] `REVERSAL` when an approved submission is later reversed.

### Phase 2 — Aggregate & rank
- [ ] Per-event light update of the acting promoter's `PromoterScore`
      (lifetime/season/rolling/streak).
- [ ] Nightly `LeaderboardScheduler`: recompute ranks per season+scope, write
      `LeaderboardSnapshot`, recompute + cache `tier` (also mirror to `PromoterProfile`).
- [ ] Season rollover logic (`seasonLengthDays`).
- [ ] Backfill job: build `point_events` from historical assignments so launch isn't
      empty.

### Phase 3 — Promoter-facing
- [ ] `GET /v1/leaderboard` + `GET /v1/promoters/me/score` endpoints + DTOs.
- [ ] Promoter app: leaderboard screen (top N, own rank, movement, season countdown) and
      a "your score" card (points, tier, progress to next tier, how-points-work).
- [ ] Decide name/handle privacy (opt-in vs. anonymized) before shipping the public board.

### Phase 4 — Admin & config
- [ ] Admin Settings: edit `leaderboard_config` (point values, multipliers, caps, season
      length, tier thresholds) — mirror the rate-config screen.
- [ ] Admin: manual `ADJUSTMENT` action (capability-gated, audited).

### Phase 5 — Tiers & gating (the future step)
- [ ] Enforce `Campaign.minTier` in `buildEligibility` (matching).
- [ ] Campaign-creation / admin UI to set `min_tier` on a campaign.
- [ ] Tier perks: tier-based `maxCampaignsPerWeek`, matching-rank boost (config-driven).
- [ ] Tier demotion with a grace period.

### Cross-cutting
- [ ] Specs: points maths (§4), idempotency/reversal, tier derivation, the matching gate.
- [ ] All tunables in `leaderboard_config` (no magic numbers in code).
- [ ] Keep it in sync with the existing scoring hooks — points are emitted alongside
      trust/reliability, never as a second source of truth for delivery outcomes.

---

*Point values, multipliers, caps, season length, and tier thresholds are all
`leaderboard_config` — the tables above are starting defaults, tunable by an admin
without a deploy.*
