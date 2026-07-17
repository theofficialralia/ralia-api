#!/usr/bin/env bash
# Stop whatever is serving the API port.
#
# Matching by command pattern is unreliable and has already cost an afternoon:
# the same server appears as `node dist/main` under `start:prod` but as
# `node --enable-source-maps /abs/path/to/dist/main` under `nest start --watch`,
# so a pattern that catches one silently misses the other. Worse, a pkill pattern
# also matches the shell that *invoked* it. The port is the thing we actually
# care about, so ask the port.
set -euo pipefail

PORT="${1:-3000}"

pids="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -z "$pids" ]; then
  echo "→ nothing listening on $PORT"
  exit 0
fi

for pid in $pids; do
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || echo '?')"
  echo "→ stopping $pid ($cmd)"
  kill "$pid" 2>/dev/null || true
done

for _ in $(seq 1 20); do
  sleep 0.25
  [ -z "$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)" ] && echo "✓ port $PORT free" && exit 0
done

echo "→ still up after SIGTERM; sending SIGKILL"
for pid in $(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
  kill -9 "$pid" 2>/dev/null || true
done
echo "✓ port $PORT free"
