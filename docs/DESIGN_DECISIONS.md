# Ralia — Design Decisions

| | |
|---|---|
| **Status** | Settled — 2 Aug 2026 |
| **Basis** | Critical review of the Admin / Client / Promoter design sets |
| **Companion to** | [ALGORITHMS.md](ALGORITHMS.md), [BACKEND_PLAN.md](BACKEND_PLAN.md) |

Fourteen product/design decisions taken after reviewing the three app design sets against the built backend. Each row is the resolution plus the design↔backend implication. Pure bugs (typos, placeholder data) are listed at the end — they need fixing, not deciding.

---

## Economics & payments

**1. Take rate → 30% default, admin-overridable.**
`RateConfig.take_rate` stays `0.30`; Admin › Platform rules exposes it as an editable field. The Performance-analytics "take rate" figure must read that value **dynamically** — not the hardcoded 12% shown in the mockups.

**2. Card payments → Paystack Inline popup.**
Remove the raw Card/CVV form drawn on the Fund step; card details are entered in Paystack's hosted popup so the app never touches the PAN and stays out of PCI scope. This is what the built client already does — redraw the step as a "Pay with Paystack" trigger.

**3. Campaign funding → client funds, admin only reviews.**
The client pays into escrow at campaign creation. Admin's role is content approval + go-live, **not** money. Rename the admin nav "Review & **fund** campaigns" → "Review & **approve**."

## Accounts & compliance

**4. Account deletion → anonymise + withdraw-first.**
Match the built backend (§7): require balance withdrawal, then soft-delete/anonymise, retain money history for records. Rewrite both apps' copy — drop "permanently deleted" and (promoter) "earnings forfeited," which are false and legally exposed.

**5. Delete confirmation → typed-"DELETE" everywhere.**
The promoter app adopts the client's typed-confirm modal, replacing the weak dashed "Proceed."

**6. Consent → opt-in by default.**
Sign-up Terms checkbox unticked (explicit consent); transactional/money alerts on, marketing/product-update notifications off by default. NDPA-aligned.

## Scoring, matching & onboarding

**7. Onboarding → required for offers.**
Scoring-critical role questions are mandatory; a promoter may pause but receives **no offers** until complete. This is the standing answer to "there's no data to match."

**8. Promoter quality → Fit % (per-offer) + Trust /100 (global).**
Drop the 4.8/5.0 star scale. Two numbers, one meaning each, both straight from the backend (`match score` → Fit %, `trust_score` → Trust /100).

**9. Reach → show effective reach + verification prompt.**
Each channel displays computed effective reach and "upload insights to raise it," surfacing the 0.6/1.0/1.15 verification tier as an incentive.

**10. Creator role → add a work-samples step.**
2–3 uploads/links; feeds the capability score and admin review. The only genuinely new onboarding field — everything else already exists in the schema.

**11. Influencer → admin-assigned tier.**
Remove from self-select onboarding; admins promote vetted high-reach promoters into it. Keeps the client wizard's "Reach a bigger audience" option meaningful.

## Taxonomy & shell

**12. Objectives → backend's five** (Awareness, Website visit, App install, Lead gen, Purchase) — plain labels, one set in wizard **and** dashboard, stored as the existing enum.

**13. Categories → one admin-managed list** (Admin › Platform rules) reused by client targeting, promoter preferences, and all role variants. No hardcoded per-screen lists.

**14. Theming → app-wide light/dark** across all three apps.

## Budget entry (refined)

The **Quote step** presents the recommended/optimal price for the chosen requirements. The client then adjusts budget against a **floor price guided by that quote**, and sees the effect on projected reach **live** as they move it. Net: remove the separate budget picker from the Targeting step — pricing lives only on Quote, as a bidirectional budget↔reach slider anchored to the recommendation with a hard floor. (Mechanics in [ALGORITHMS.md](ALGORITHMS.md) §2.)

---

## Not decisions — fixes to sweep

- **Typos:** "Procced," "at lease/at least 8" (→ **10**), "Fufilled," "Canpaign Duration," "anymote" (→ anymore), "performace," "Paticiators," "violets" (→ violates), "Ralila," "Total promotes."
- **Impossible placeholder data:** descending ranges ("18,400 – 10,000" views, "≈3,495–2,100 per promoter"); Earnings where Lifetime earned < This month, and a withdrawal exceeding balance; a chart Y-axis labelled "₦1200k" four times; "Spend by category" listing Retail twice; a rejection demanding "12k views" on a ~840-view campaign.
- **Identity bleed:** every Promoter screen's sidebar shows "Skinsmith LTD"; a rejection greets "Hello David" (user is Chiamaka); Admin › Team & Roles marks the logged-in "Oluoma U." as "Ngozi Adeyemi… Suspended… This is you."
- **Duplicated controls:** "Cancel & Return" twice per wizard step; a "Back" button on step 1.
