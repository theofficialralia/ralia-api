#!/usr/bin/env bash
# Checks the host ports this stack binds are free, or already held by our own
# containers. This machine runs other projects; a collision otherwise surfaces as
# an opaque "port is already allocated" from the Docker daemon.
set -uo pipefail

fail=0

check_port() {
  local port="$1" label="$2"
  local holder
  holder=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -Fc 2>/dev/null | grep '^c' | head -1 | cut -c2-)
  if [ -z "$holder" ]; then
    return 0
  fi
  # Our own container already listening is fine — compose will reuse it.
  if docker compose ps --format '{{.Publishers}}' 2>/dev/null | grep -q ":${port}->"; then
    return 0
  fi
  echo "  ✗ port ${port} (${label}) is held by: ${holder}"
  fail=1
}

check_port 5433 postgres
check_port 6380 redis
check_port 9000 minio
check_port 9001 "minio console"
check_port 1025 mailpit
check_port 8025 "mailpit ui"

if ! docker info > /dev/null 2>&1; then
  echo "  ✗ Docker daemon is not running — start Docker Desktop and retry."
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Fix the conflicts above, or change the host port in docker-compose.yml"
  echo "and the matching URL in .env."
  exit 1
fi
