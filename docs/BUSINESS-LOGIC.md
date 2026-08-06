# Ralia — How the Business Works

*A plain-language guide to the logic behind Ralia: how the pieces fit together, and how it makes money.*
*Audience: the product owner and anyone who needs the business picture, not the code.*

---

## 1. What Ralia is, in one line

**Ralia turns everyday people's social reach into paid advertising for businesses — and takes a cut of every campaign.**

Think of it like this: a business wants Nigerians to hear about their product. Instead of paying one big influencer a lump sum and hoping, they fund a campaign, and Ralia hands it to **dozens of ordinary people** — someone with an active WhatsApp status, a small Instagram, a busy Telegram group — who each post it to their own audience and get paid for the real reach they deliver. Ralia is the marketplace, the referee, and the bank in the middle.

Two sides, curated by us:

- **Businesses (we call them *clients*)** — put money in to get their message out.
- **Promoters** — everyday people who post campaigns to their channels and earn a fee.
- **Ralia (admin)** — approves who and what comes in, verifies the work, moves the money, and keeps both sides honest.

---

## 2. The four pieces of software (and why each exists)

| Piece | Who uses it | What it's for |
|---|---|---|
| **Client app** | Businesses | Create and fund a campaign, watch delivery, see what they got for their money |
| **Promoter app** (mobile-first) | Promoters | Get matched offers, accept, post, submit proof, get paid, cash out |
| **Admin console** | The Ralia team | Approve promoters & campaigns, verify proof, release money, watch the books |
| **The backend (the engine)** | Nobody directly | The brain: pricing, matching, the money ledger, automation. Everything above talks to it |

The three apps are just *windows* into the one engine. The engine is where the business rules and the money actually live — so the rules can't be gamed by editing an app.

---

## 3. How Ralia makes money — the core

**Ralia and its promoters split every campaign 50/50.** For every naira a client spends, half goes to the promoters who deliver the work, and half is Ralia's revenue.

That 50% — the **take rate** — is the revenue. Nothing else. It's a knob we can change per the market, but 50/50 is the default.

> **Worked example.** A Distribution slot is priced at **₦3,000**.
> - The promoter who fills it earns **₦1,500** (50%).
> - Ralia keeps **₦1,500** (50%).
>
> Scale that up: **for every ₦1,000,000 clients spend on campaigns in a month, Ralia earns ₦500,000** — with almost no extra cost per campaign, because the engine runs the matching, verification, and payouts automatically.

The beauty of this model: **Ralia never fronts money.** The client's money is held in trust and only released as verified work is delivered. Ralia's cut comes *out of money that's already in the building*.

---

## 4. Pricing — the key questions, answered

A client never names a price — the engine calculates it, the same way every time, from what they ask for. Here are the three questions that come up most, answered in plain terms.

### Q1 — What is RPM?

**RPM = the price of a thousand pairs of eyeballs**, before any adjustments. ("RPM" = *rate per mille*; mille = thousand.) The rate depends on the **campaign category** (see Q2) — a distributor is paid for *reach*, a creator mostly for the *work* of making content, so the two are priced very differently per view:

| Category | RPM (per 1,000 effective views) |
|---|--:|
| Distribution | ₦3,000 |
| Creation / Participation | ₦500 |

RPM is a dial we can turn per category to move prices with the market, and it's always charged against **effective reach** (the honest, discounted number — see §5), never a promoter's claimed follower count.

### Q2 — What is a "slot price", and what are the category floors?

A **slot** is one promoter's spot in a campaign. A campaign's total is simply *slot price × number of slots*. The slot price is:

```
slot price = (effective reach ÷ 1,000) × category RPM × objective multiplier × targeting multiplier
```

- **Objective multiplier** — a "get someone to buy" campaign is worth more than a "just be seen" one: Awareness ×1.0 · Website visit ×1.1 · App install ×1.25 · Lead ×1.4 · **Purchase ×1.5**.
- **Targeting multiplier** — the tighter you target (states, ages, languages, categories), the more each slot costs, up to a cap. Precision is a premium.

**Every campaign belongs to a category, and each category has a minimum size** — a floor below which a campaign can't be booked, plus a sensible default reach-per-slot and promoter count that the client can scale up from:

| Category | Roles it covers | Min campaign fee | Default reach / promoter | Default promoters |
|---|---|--:|--:|--:|
| **Distribution** | Distributor | **₦15,000** | 1,000 | 5 |
| **Creation / Participation** | Creator, Participator | **₦100,000** | 10,000 | 20 |

> **Worked examples (at 50/50).**
> - **Distribution** — 5 promoters × 1,000 reach at ₦3,000 RPM = a **₦15,000** campaign. Each promoter earns **₦1,500**; Ralia keeps **₦1,500** per slot (₦7,500 total).
> - **Creation** — 20 promoters × 10,000 reach at ₦500 RPM = a **₦100,000** campaign. Each promoter earns **₦2,500**; Ralia keeps **₦2,500** per slot (₦50,000 total).

The floors guarantee the promoter's fee is always worth the effort: even at a 50/50 split, a Distribution post pays ₦1,500 and a Creation piece ₦2,500. (A tougher objective or tighter targeting scales these *up* from the baseline; the floor is only the minimum.)

**Two prices to keep straight.** At **quote time** the slot is priced on the reach the *client asked for* (the category default, or more), so the figure is predictable and doesn't depend on who happens to be available. At **offer time**, each real promoter's slot is priced on *their own* effective reach and they're paid pro-rata on what they actually deliver.

### Q3 — How is the price shown to the client, and how does the slider recalculate?

The client picks a **category** (which sets the rate, the floor, and sensible defaults), then adjusts. Two things stay **fixed** as they drag the slider:

- **Slot price** — e.g. ₦3,000 for a Distribution slot.
- **Reach per slot** — e.g. 1,000 (the category default).

The slider is a **budget dial**, and it **opens at the category floor** (₦15,000 for Distribution). Dragging it up changes only **how many slots the budget can buy**, and reach follows from that:

```
slots = budget ÷ slot price     (rounded DOWN — you can't buy half a promoter)
reach = slots × reach-per-slot
total = slots × slot price       (what's charged; ≤ the slider value)
```

So the chain is **budget → number of slots → total reach.** More budget affords more slots, each adding another slot's worth of reach.

| Budget (Distribution) | Slots it buys | Total reach | Price actually charged |
|---|--:|--:|--:|
| ₦15,000 (the floor) | 5 | 5,000 | ₦15,000 |
| ₦30,000 | 10 | 10,000 | ₦30,000 |
| ₦60,000 | 20 | 20,000 | ₦60,000 |

Two things to notice:
- The slider **won't go below the category floor** (₦15,000 for Distribution, ₦100,000 for Creation) — that's the minimum booking.
- The charged total **snaps to whole slots**: leftover that can't cover a whole extra promoter is dropped, so reach moves in **steps of one slot** at a time, not smoothly.

*Today the slider opens at the category floor. A **"Recommended budget"** — where Ralia suggests a sensible starting spend for the client's objective and targeting, above the floor — is a planned **coming-soon** enhancement.*

---

## 5. "Effective reach" — the honest-numbers rule that protects clients

Anyone can *claim* 50,000 followers. Clients would be furious paying for views that never happen. So Ralia never prices on the claimed number — it prices on **effective reach**: a deliberately conservative estimate of *how many people actually see the post.*

```
effective reach ≈ claimed audience × platform factor × verification factor
```

- **Platform factor** — a WhatsApp *status* reaches a bigger share of contacts than an Instagram post reaches followers, so each platform is discounted differently.
- **Verification factor** — self-reported numbers are trusted least (×0.6) and capped low; a **screenshot** of insights lifts it (×1.0); connected **platform insights** lift it most (×1.15). Proof "ages out" after ~90 days so numbers stay current.

> **Example.** A promoter claims **20,000 Instagram followers**, self-reported. Effective reach ≈ 20,000 × 0.10 × 0.6 ≈ **1,200** — and that (not 20,000) is what a client pays against. If they upload a genuine insights screenshot, it rises. **Honesty is rewarded; inflation is priced out.**

This single rule is what makes the marketplace trustworthy enough for businesses to spend on.

---

## 6. Matching — picking the *right* promoters, not just the biggest

When a campaign goes live, the engine scores every eligible promoter and offers slots to the best fits. Each promoter even sees their **"Fit %"** on the offer. The score blends:

- **Capability** — how good they are at this *kind* of work (posting reach, content quality, task reliability), captured at sign-up and confirmed by an admin.
- **Trust** — their track record (starts at 50/100).
- **Reliability** — do they deliver, on time?
- **Right-sized reach** — a slot that needs 2,000 views goes to someone who fits it, *not* to the biggest account (that would waste reach and money).
- **Category fit** — a fashion campaign prefers fashion promoters.
- **Fatigue** — someone already busy this week is rested, not overloaded.

There's also a **newbie gate**: when there are plenty of proven promoters, unproven ones wait; when supply is tight, everyone gets a shot. The result: **good delivery without babysitting**, and the pool self-curates.

---

## 7. Reputation — why the marketplace gets better on its own

Every promoter carries a **trust score** that moves with behaviour — earned slowly, lost quickly:

| What they did | Trust change |
|---|--:|
| Delivered on time | **+2** |
| Delivered late | +0.5 |
| Submission rejected | **−6** |
| Missed the deadline / no-show | **−10** |

Reliable promoters rise and get first pick of the best campaigns; flaky ones fade out of the matching. **Clients get better delivery over time without Ralia lifting a finger** — the incentives do the work.

---

## 8. The full journey — one campaign, start to finish

Here's how the apps, the engine, and the money come together in a single run:

1. **Fund** — *Naija Threads* opens the **client app**, builds a campaign, uses the slider to spend ₦X for ~12 promoters, and pays by card (Paystack) or bank transfer. The money lands in a locked **escrow** account — held in trust, not yet anyone's.
2. **Approve** — Ralia reviews the campaign in the **admin console** and takes it live.
3. **Match** — the **engine** automatically offers the 12 slots to the best-fit promoters. They see the offer, the fee, and their Fit % in the **promoter app**.
4. **Post & prove** — a promoter accepts, posts to their status, and submits a screenshot + shares a **Ralia tracking link**. Every real click on that link is counted (bots filtered out).
5. **Verify** — Ralia (admin) checks the screenshot and the clicks, and approves the delivered views.
6. **Pay, exactly for what was delivered** — the engine splits the money in one clean move: the promoter's **50%** for what they actually delivered, Ralia's **50%**, and any **undelivered remainder refunded to the client**. Deliver less than 70% of what was promised? No payment — resubmit. Nobody is over- or under-paid by a single kobo.
7. **Cash out** — the promoter requests a withdrawal in the app; after a one-time **identity check (KYC)**, Ralia sends the bank transfer.

Every one of those money moves is written into a **double-entry ledger** — the same discipline banks use. There is no "balance" that can drift; a balance is always the sum of recorded movements, so the books can never silently go wrong.

---

## 9. Trust with money and data (why businesses and regulators can rely on it)

- **Money is always backed.** Promoters are only ever paid from money a client already put in escrow. Ralia can produce an **exposure report** at any moment proving that what it owes promoters is fully covered — it can never over-commit.
- **Every money- or score-changing action is logged** (who, what, when) — a permanent audit trail.
- **KYC before cash leaves**, and **consent is captured** where personal data is collected (aligned with Nigeria's data-protection expectations).
- **Failed or bounced payouts are handled cleanly** — money returns to the promoter's balance, never lost.

---

## 10. It runs itself — which is what makes it a *business*, not a job

The engine does the repetitive work automatically, around the clock:

- **Auto-matches** offers to open campaigns.
- **Sets deadlines** and, if a promoter goes quiet, **reclaims the slot** and offers it to someone else — so campaigns still fill.
- **Notifies both sides** at every step (offer received, paid, approved…) by **email today, with WhatsApp ready to switch on** — so people act without Ralia chasing them.

This is the difference between a marketplace that needs an operator babysitting every campaign and one that **scales**: more campaigns don't mean proportionally more staff.

---

## 11. The flywheel — how it compounds

```
        more businesses fund campaigns
                  │
                  ▼
        promoters earn more  ───────►  better, more promoters join
                  ▲                              │
                  │                              ▼
        businesses come back  ◄──────  delivery gets better & cheaper
```

Ralia's revenue = **half of everything that flows through it.** So the whole job is to keep that flow growing and honest: honest reach numbers bring businesses in, reliable delivery keeps them, and reputation + automation make delivery better and cheaper over time. Every naira of campaign spend carries Ralia's margin with it, at almost zero marginal cost.

---

## 12. The one-paragraph version (for a pitch)

> Ralia is a two-sided marketplace that lets Nigerian businesses buy real word-of-mouth reach from a curated crowd of everyday promoters. Businesses fund campaigns priced on *honest, verified* reach; the engine matches each campaign to the best-fit promoters, verifies their delivery with screenshots and real link-clicks, and pays them pro-rata for exactly what they delivered — holding all funds in a bank-grade ledger. **Ralia and its promoters split every campaign 50/50.** Because pricing, matching, verification, payouts, and notifications are automated, the margin scales with volume rather than headcount.

---

*This document describes Ralia's agreed business logic and pricing model. The specific numbers (the 50/50 split, the per-category rates and floors, the multipliers, the 70% delivery threshold, KYC and withdrawal rules) are configurable settings, not hard-coded — they can be tuned as the business learns, without rebuilding the product.*
