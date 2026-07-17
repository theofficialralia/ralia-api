#!/usr/bin/env bash
# Rolls back the most recently applied migration by running its down.sql and
# removing its row from _prisma_migrations, so `prisma migrate deploy` will
# re-apply it cleanly.
#
# Dev/staging only. Rolling back in production is an incident decision, not a
# script — expand-then-contract exists so you don't have to (handoff §8).
set -euo pipefail

if [ "${NODE_ENV:-development}" = "production" ]; then
  echo "✗ Refusing to run against NODE_ENV=production." >&2
  exit 1
fi

LATEST=$(ls -1 prisma/migrations | grep -v migration_lock | sort | tail -1)
DOWN="prisma/migrations/$LATEST/down.sql"

if [ ! -f "$DOWN" ]; then
  echo "✗ $LATEST has no down.sql — generate one with ./scripts/make-down.sh" >&2
  exit 1
fi

echo "→ rolling back $LATEST"
docker compose exec -T postgres psql -U ralia -d ralia -v ON_ERROR_STOP=1 -q < "$DOWN"
docker compose exec -T postgres psql -U ralia -d ralia -v ON_ERROR_STOP=1 -q \
  -c "DELETE FROM _prisma_migrations WHERE migration_name = '$LATEST';"
echo "→ rolled back $LATEST"
