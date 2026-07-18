# Ralia API

Backend for the Ralia MVP — a two-sided marketplace where businesses create advertising campaigns and promoters post them to their own social channels for a fee.

Build plan and phase order: [docs/BACKEND_PLAN.md](docs/BACKEND_PLAN.md). Scope is fixed by the Claude Code Handoff (DSD-RALIA-CC-R02) — see §11 of that document before adding anything.

## Local setup

Requires Docker, Node 20+.

```bash
make up
```

That copies `.env.example` → `.env`, generates dev secrets, starts postgres/redis/minio/mailpit, installs, migrates, seeds, and runs the API in watch mode.

| Service | URL |
|---|---|
| API | http://localhost:3000 |
| Health | http://localhost:3000/health |
| Mailpit | http://localhost:8025 |
| MinIO console | http://localhost:9001 |
| Postgres | `localhost:5433` — **not** 5432, to leave a native postgres install alone |

Seeded accounts, password `Password123!`:

- `admin@ralia.test`
- `client1@ralia.test`, `client2@ralia.test`
- `promoter1@ralia.test` … `promoter40@ralia.test`

## Commands

```bash
make up        # clean checkout → running seeded API, one command
make down      # stop containers, keep data
make reset     # destroy data, re-migrate, re-seed
make migrate   # create and apply a migration
make seed      # re-run the seed
make test      # test suite
make psql      # psql shell into the dev database
make openapi   # write docs/openapi.json from the code
make verify-loop  # drive the whole loop through the live API
make gate      # openapi + a dated end-to-end run, as gate evidence
```

## Verifying the whole thing works

`make verify-loop` drives the complete product loop through the public API
against a running server, and asserts the money at each step:

```
register client + promoter → profile + channel → admin approves promoter
→ create, price and fund a campaign → candidates → offer → accept
→ click the tracking link → submit proof → admin approves
→ ledger pays the promoter → withdraw → admin records the payout
```

It ends by checking that the payout was **one balanced transaction**, that the
books close (cash held = everything owed plus earned), and that every decision
left an audit row. It exits non-zero on the first failed assertion, so it is
usable as a smoke test, not just a demo.

`make gate` runs that and writes a dated transcript to `docs/gate-evidence/`,
alongside the generated `docs/openapi.json`. Together these are the Phase-2 gate
artifacts: the frozen contract, and dated proof the loop runs end to end.

Two things to know when running it:

- It registers two accounts per run and registration is rate-limited to 5/min, so
  wait a minute between runs. The script says so plainly if it is throttled.
- It needs `DEV_OTP_LOG` set (see `.env.example`) so it can complete a real
  signup through the API. The console OTP provider that writes it refuses to boot
  in production, so this seam cannot exist there.

## Migrations

Expand-then-contract: never write a migration that breaks the currently running version. Every migration ships a tested `down.sql`.

Prisma has no native down migrations, so the down SQL is generated from a diff taken **before** the migration is applied:

```bash
./scripts/make-down.sh              # 1. stage reverse SQL (DB still has the old shape)
npx prisma migrate dev --name foo   # 2. create + apply the migration
./scripts/make-down.sh <dir>        # 3. file down.sql into that migration
./scripts/migrate-down.sh           # roll back the latest migration (dev/staging only)
```

CI fails the build if `schema.prisma` has drifted from the migration history.

## Rules that are not negotiable

These are encoded in the schema and enforced in review. See the handoff for the reasoning.

- **Money is `BigInt` minor units (kobo).** Never `Float`. Ever.
- **There is no balance column.** Balances are always `SUM(ledger_entries)`.
- **Every ledger transaction balances**: `sum(debits) = sum(credits)`.
- **`ledger_*` and `audit_log` are append-only.** Never edited, never deleted.
- **Every mutating money endpoint requires an `Idempotency-Key`** and rejects the request without one.
- **`effective_reach` is computed server-side**, never accepted from a client.
- **No secret in the repo.** Everything via env; `.env.example` is the contract.
- Never log bank details, OTPs, or tokens.

## Layout

```
prisma/
  schema.prisma      # the frozen data model (handoff §4)
  migrations/        # each with migration.sql + down.sql
  seed.ts            # 2 clients, 40 promoters, 3 campaigns, all 37 states
src/
  common/            # prisma, shared pure logic (reach formula)
  health/
scripts/             # secret generation, down-migration tooling
docs/BACKEND_PLAN.md # phases, milestones, open decisions
```
