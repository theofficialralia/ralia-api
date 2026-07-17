#!/usr/bin/env bash
# Generates down.sql for the migration you are ABOUT to create.
#
# Prisma has no native down migrations, but the handoff (§8) requires every
# migration to have a tested down path. The recipe:
#
#   1. Edit prisma/schema.prisma.
#   2. Run this script — it diffs the NEW datamodel against the CURRENT database
#      and writes the reverse SQL to a staging file. Order matters: this must run
#      BEFORE `prisma migrate dev`, while the DB still holds the old shape.
#   3. Run `npx prisma migrate dev --name <name>`.
#   4. Run this script again with the new migration's directory name to file the
#      staged down.sql alongside its migration.
#
# Usage:
#   ./scripts/make-down.sh                 # stage the down SQL (step 2)
#   ./scripts/make-down.sh <migration_dir> # file it into that migration (step 4)
set -euo pipefail

STAGED=".down.staged.sql"

if [ $# -eq 0 ]; then
  npx prisma migrate diff \
    --from-schema-datamodel prisma/schema.prisma \
    --to-schema-datasource prisma/schema.prisma \
    --script > "$STAGED"
  echo "→ staged reverse SQL to $STAGED ($(grep -c ';' "$STAGED" || true) statements)"
  echo "  now run: npx prisma migrate dev --name <name>"
  echo "  then:    ./scripts/make-down.sh <migration_dir>"
  exit 0
fi

TARGET="prisma/migrations/$1"
if [ ! -d "$TARGET" ]; then
  echo "✗ no such migration: $TARGET" >&2
  exit 1
fi
if [ ! -f "$STAGED" ]; then
  echo "✗ $STAGED not found — run this script with no arguments before migrating." >&2
  exit 1
fi

mv "$STAGED" "$TARGET/down.sql"
echo "→ $TARGET/down.sql"
