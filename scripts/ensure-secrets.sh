#!/usr/bin/env bash
# Fills empty secrets in .env with generated dev values so `make up` works from a
# clean checkout without hand-editing. Never overwrites a value that is already set,
# and never runs against a non-development .env.
set -euo pipefail

ENV_FILE="${1:-.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ $ENV_FILE not found" >&2
  exit 1
fi

if grep -qE '^NODE_ENV=(production|staging)' "$ENV_FILE"; then
  echo "→ $ENV_FILE is not a development env; leaving secrets alone."
  exit 0
fi

gen() { openssl rand -hex 32; }

fill_if_empty() {
  local key="$1"
  if grep -qE "^${key}=$" "$ENV_FILE"; then
    local value
    value="$(gen)"
    # BSD and GNU sed disagree on -i; write via a temp file instead.
    awk -v k="$key" -v v="$value" \
      '$0 == k"=" { print k"="v; next } { print }' \
      "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
    echo "→ generated $key"
  fi
}

fill_if_empty JWT_ACCESS_SECRET
fill_if_empty JWT_REFRESH_SECRET
fill_if_empty FIELD_ENCRYPTION_KEY
fill_if_empty TRACKING_HASH_SALT
