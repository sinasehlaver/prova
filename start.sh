#!/usr/bin/env bash
# Start both backend and frontend, clean up on Ctrl+C

set -euo pipefail

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo ""
  echo "Shutting down..."
  if [[ -n "$BACKEND_PID" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "$FRONTEND_PID" ]]; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi
  # Give them a moment to exit gracefully
  sleep 0.2
  # Force kill if still alive
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill -9 "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ -n "$FRONTEND_PID" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill -9 "$FRONTEND_PID" 2>/dev/null || true
  fi
  wait 2>/dev/null || true
  echo "Done."
  exit 0
}

trap cleanup INT TERM

echo "Starting backend..."
node --watch server/index.mjs &
BACKEND_PID=$!

echo "Starting frontend..."
npx vite --config web/vite.config.js &
FRONTEND_PID=$!

echo "Both processes started. Backend PID: $BACKEND_PID, Frontend PID: $FRONTEND_PID"
echo "Press Ctrl+C to stop both."

# Wait for both processes (wait -n not portable, use simple wait)
wait