#!/usr/bin/env bash
# One command to try the app after a change: deps, dev DB, API :4600 + web :4601, login links, Chrome.
# Usage: ./start.sh [--fresh] [--no-open]
#   --fresh    delete dev.db first (re-seeds demo data + test users)
#   --no-open  don't open Chrome, just print the links
# Uses prova/dev.db (gitignored, demo data) — never prova.db. Ctrl+C stops both processes.

set -euo pipefail
cd "$(dirname "$0")"

API_PORT=4600
WEB_PORT=4601
WEB="http://localhost:$WEB_PORT"
FRESH=0
OPEN=1
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    --no-open) OPEN=0 ;;
    -h|--help) sed -n 2,6p "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)"; exit 2 ;;
  esac
done

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo ""
  echo "Shutting down..."
  for pid in "$BACKEND_PID" "$FRONTEND_PID"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  # Give them a moment to exit gracefully, then force
  sleep 0.2
  for pid in "$BACKEND_PID" "$FRONTEND_PID"; do
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "Done."
  exit "${1:-0}"
}

# 1. Dependencies: install when missing or package-lock.json changed since the last install.
if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
  echo "Installing dependencies..."
  npm install --no-audit --no-fund
fi

# 2. Ports: a leftover run of THIS app (cwd = this dir) is stopped; anything else is reported, not killed.
here="$(pwd -P)"
for port in "$API_PORT" "$WEB_PORT"; do
  for pid in $(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true); do
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    if [[ "$cwd" == "$here" ]]; then
      echo "Stopping a previous prova run on :$port (pid $pid)..."
      kill "$pid" 2>/dev/null || true
    else
      echo "Port $port is used by another program (pid $pid: $(ps -o comm= -p "$pid")). Stop it and re-run."
      exit 1
    fi
  done
  for _ in $(seq 1 25); do lsof -nP -t -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.2; done
done

# 3. Dev DB: migrate, demo seed, one test user per role; prints "label<TAB>login link".
[[ "$FRESH" = 1 ]] && rm -f dev.db dev.db-*
links="$(node scripts/dev-db.mjs "$WEB")"

trap "cleanup 0" INT TERM

# 4. Start both (API on loopback only).
echo "Starting backend..."
HOST=127.0.0.1 PORT="$API_PORT" DATABASE_URL="file:dev.db" node --watch server/index.mjs &
BACKEND_PID=$!

echo "Starting frontend..."
npx vite --config web/vite.config.js --strictPort &
FRONTEND_PID=$!

ready() { curl -sf -o /dev/null "$1"; }
for _ in $(seq 1 100); do
  ready "http://127.0.0.1:$API_PORT/api/health" && ready "$WEB/" && break
  kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null || { echo "A process exited during startup (see output above)."; cleanup 1; }
  sleep 0.2
done
ready "$WEB/" || { echo "App didn't come up within 20 s (see output above)."; cleanup 1; }

# 5. Links + Chrome. One browser = one session cookie: open another link to switch user.
echo ""
echo "prova is ready at $WEB — dev logins (local demo DB only):"
while IFS=$'\t' read -r label url; do printf '  %-32s %s\n' "$label" "$url"; done <<< "$links"
echo "Ctrl+C stops both."
first="$(head -n1 <<< "$links" | cut -f2)"
if [[ "$OPEN" = 1 ]]; then
  open -a "Google Chrome" "$first" 2>/dev/null || open "$first" 2>/dev/null || xdg-open "$first" >/dev/null 2>&1 || true
fi

wait
