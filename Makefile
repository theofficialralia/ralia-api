.PHONY: up down reset seed migrate dev test logs psql stop-api help

# One-command bring-up from a clean checkout: infra, schema, seed data, API.
up:
	@./scripts/preflight.sh
	@test -f .env || (cp .env.example .env && echo "→ .env created from .env.example")
	@./scripts/ensure-secrets.sh
	# --wait only covers long-running services; minio-init is a one-shot that
	# exits 0, which --wait would otherwise report as a failure.
	docker compose up -d --wait postgres redis minio mailpit
	docker compose run --rm minio-init
	npm install
	npx prisma generate
	npx prisma migrate deploy
	npm run seed
	@echo ""
	@echo "  API        → http://localhost:3000"
	@echo "  Mailpit    → http://localhost:8025"
	@echo "  MinIO      → http://localhost:9001"
	@echo ""
	npm run start:dev

down:
	docker compose down

# Destroys all dev data and rebuilds from migrations + seed.
reset:
	docker compose down -v
	docker compose up -d --wait
	npx prisma migrate reset --force

migrate:
	npx prisma migrate dev

seed:
	npm run seed

dev:
	@./scripts/stop-api.sh
	npm run start:dev

test:
	npm test

logs:
	docker compose logs -f

psql:
	docker compose exec postgres psql -U ralia -d ralia

stop-api:
	@./scripts/stop-api.sh

help:
	@echo "make up      — clean checkout to running seeded API (one command)"
	@echo "make down    — stop containers, keep data"
	@echo "make reset   — destroy data, re-migrate, re-seed"
	@echo "make migrate — create/apply a migration"
	@echo "make seed    — re-run the seed script"
	@echo "make test    — run the test suite"
	@echo "make psql    — psql shell into the dev database"
	@echo "make stop-api — stop whatever holds port 3000"
