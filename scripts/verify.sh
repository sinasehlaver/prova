#!/bin/bash
# Tests, then boot prova on a free port with a throwaway file: DB + demo seed, smoke the API, browser check.
# Usage: npm run verify   (browser step needs Chrome; skipped with a warning if playwright/Chrome is missing)
# Screenshots: PROVA_SHOTS=<dir> npm run verify  (default: a temp dir that is deleted on exit)
set -euo pipefail
cd "$(dirname "$0")/.."

npm test --silent
npm run build --silent

port=$(../.claude/scripts/freeport.sh)
tmp=$(mktemp -d -t prova-verify)
tok="verify-admin-token"
export PORT="$port" DATABASE_URL="file:$tmp/verify.db" SEED_DEMO=1 ADMIN_INVITE_TOKEN="$tok"
node server/index.mjs > "$tmp/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$tmp"' EXIT

B="http://127.0.0.1:$port"
for _ in $(seq 1 50); do curl -sf "$B/api/health" >/dev/null && break; sleep 0.2; done

echo "--- api"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/me")" = 401 ] || { echo "expected 401 unauth"; exit 1; }
jar="$tmp/jar"
curl -s -c "$jar" -o /dev/null "$B/i/$tok"
curl -sf -b "$jar" "$B/api/me" | grep -q '"role":"admin"' || { echo "admin login failed"; exit 1; }
n=$(curl -sf -b "$jar" "$B/api/users" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).length)')
[ "$n" = 4 ] || { echo "expected 4 seeded users, got $n"; exit 1; }
echo "login ok, $n users"

# reservations: create ok, overlapping rejected 409, back-to-back (end == start) ok. Day +30 keeps the browser check's slots free.
start=$(node -e 'console.log(Math.ceil(Date.now()/36e5)*36e5 + 30*864e5)')
post() { curl -s -b "$jar" -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d "{\"start_ms\":$1,\"hours\":$2}" "$B/api/reservations"; }
[ "$(post "$start" 2)" = 201 ] || { echo "reservation create failed"; exit 1; }
[ "$(post "$((start + 3600000))" 2)" = 409 ] || { echo "overlap not rejected"; exit 1; }
[ "$(post "$((start + 7200000))" 1)" = 201 ] || { echo "back-to-back booking rejected"; exit 1; }
echo "reservations ok (create, overlap 409, boundary)"

# alerts: raise twice -> same open alert (201 then 200), close, none left open
araise() { curl -s -b "$jar" -w '\n%{http_code}' -H 'content-type: application/json' -d '{"kind_id":2}' "$B/api/alerts"; }
a1=$(araise); a2=$(araise)
id1=$(echo "$a1" | head -1 | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).id)')
id2=$(echo "$a2" | head -1 | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).id)')
[ "$(echo "$a1" | tail -1)" = 201 ] && [ "$(echo "$a2" | tail -1)" = 200 ] && [ "$id1" = "$id2" ] || { echo "alert raise not idempotent"; exit 1; }
[ "$(curl -s -b "$jar" -o /dev/null -w '%{http_code}' -X POST "$B/api/alerts/$id1/close")" = 200 ] || { echo "alert close failed"; exit 1; }
[ "$(curl -sf -b "$jar" "$B/api/alerts")" = "[]" ] || { echo "alert still open after close"; exit 1; }
echo "alerts ok (raise idempotent, close)"

# billing: subscription charge materialised (1500); the member self-serve dekont upload is SWITCHED OFF (403) and an
# admin records a part-payment by hand instead (1.000 of 1.500 -> item stays unpaid, kalan 500)
js() { node -e "const j=JSON.parse(require('fs').readFileSync(0));$1"; }
bill=$(curl -sf -b "$jar" "$B/api/billing")
month=$(echo "$bill" | js 'console.log(j.month)')
[ "$(echo "$bill" | js 'console.log(j.items.find(i=>i.kind==="subscription").amount_try)')" = 1500 ] || { echo "subscription charge != 1500"; exit 1; }
mtok=$(curl -sf -b "$jar" -H 'content-type: application/json' -d '{"name":"Smoke Üye"}' "$B/api/users" | js 'console.log(j.invite_token)')
mid=$(curl -sf -b "$jar" "$B/api/users" | js 'console.log(j.find(u=>u.name==="Smoke Üye").id)')
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "cookie: prova_session=$mtok" -H 'content-type: application/pdf' --data-binary @fixtures/receipts/enpara-1500.pdf "$B/api/billing/receipts?month=$month")" = 403 ] || { echo "member self-serve upload must be 403"; exit 1; }
rec=$(curl -s -b "$jar" -X POST -H 'content-type: application/pdf' --data-binary @fixtures/receipts/enpara-1000-mismatch.pdf "$B/api/admin/users/$mid/receipts?amount_try=1000&filename=elle.pdf&note=Elle+kaydedildi")
echo "$rec" | grep -q '"applied_try":1000' || { echo "manual payment record failed: $rec"; exit 1; }
curl -sf -b "$jar" "$B/api/admin/users/$mid/billing" | js 'const s=j.items.find(i=>i.kind==="subscription");if(s.status!=="unpaid"||s.paid_try!==1000||j.kalan!==500)process.exit(1)' || { echo "manual part-payment not reflected"; exit 1; }
# admin overview: every member listed with their outstanding, and the total = the sum of the rows (default = current month)
curl -sf -b "$jar" "$B/api/admin/billing/overview" | js 'const m=j.users.find(u=>u.name==="Smoke Üye");
  if(!m||m.outstanding_try!==500||m.debt_try!==500)process.exit(1);
  if(j.total_outstanding_try!==j.users.reduce((s,u)=>s+u.outstanding_try,0))process.exit(2);
  if(j.total_debt_try!==j.users.reduce((s,u)=>s+u.debt_try,0))process.exit(3);' || { echo "admin billing overview wrong"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "cookie: prova_session=$mtok" "$B/api/admin/billing/overview")" = 403 ] || { echo "member reached the billing overview"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "cookie: prova_session=$mtok" "$B/api/admin/receipts")" = 403 ] || { echo "member reached admin receipts"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "cookie: prova_session=$mtok" -H 'content-type: application/pdf' --data-binary @fixtures/receipts/enpara-1500.pdf "$B/api/admin/receipts/parse")" = 403 ] || { echo "member reached the dekont parser"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "cookie: prova_session=$mtok" "$B/api/billing")" = 200 ] || { echo "member billing failed"; exit 1; }
echo "billing ok (charge 1500, self-serve upload off, admin part-payment recorded, member gated)"

# economics: admin-only; a big cost this month makes the summary suggest an increase (browser step applies it)
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "cookie: prova_session=$mtok" "$B/api/admin/economics")" = 403 ] || { echo "member reached economics"; exit 1; }
cc=$(curl -s -b "$jar" -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d "{\"month\":\"$month\",\"category\":\"kira\",\"amount_try\":40000}" "$B/api/admin/costs")
[ "$cc" = 201 ] || { echo "cost create failed: [$cc]"; exit 1; }
curl -sf -b "$jar" "$B/api/admin/economics" | js 'if(j.months.length!==6||j.suggestion.status!=="increase"||!j.suggestion.options.combined)process.exit(1)' || { echo "economics summary/suggestion wrong"; exit 1; }
echo "economics ok (member gated, cost, summary + suggestion)"

# export: admin-only, attachment, JSON has the money tables and no invite tokens; CSV has a BOM. PWA: manifest + icons are served.
[ "$(curl -s -o /dev/null -w '%{http_code}' -H "cookie: prova_session=$mtok" "$B/api/admin/export")" = 403 ] || { echo "member reached export"; exit 1; }
curl -sf -b "$jar" -D "$tmp/exp.h" "$B/api/admin/export" | js 'for(const k of ["users","charges","receipts","costs","settings"])if(!Array.isArray(j[k]))process.exit(1);if(JSON.stringify(j).includes("'"$tok"'"))process.exit(2)' || { echo "export json wrong or leaks invite token"; exit 1; }
grep -qi 'content-disposition: attachment' "$tmp/exp.h" || { echo "export not an attachment"; exit 1; }
[ "$(curl -sf -b "$jar" "$B/api/admin/export?format=csv" | head -c 3 | od -An -tx1 | tr -d ' \n')" = efbbbf ] || { echo "csv export missing BOM"; exit 1; }
curl -sf "$B/manifest.webmanifest" | js 'if(j.lang!=="tr"||j.display!=="standalone")process.exit(1)' || { echo "manifest not served"; exit 1; }
for f in icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png icon.svg; do [ "$(curl -s -o /dev/null -w '%{http_code}' "$B/$f")" = 200 ] || { echo "icon $f not served"; exit 1; }; done
curl -sf "$B/" | grep -q 'rel="manifest"' || { echo "index.html has no manifest link"; exit 1; }
echo "export + pwa ok (member 403, json/csv, manifest, icons)"

echo "--- browser check"
shots="${PROVA_SHOTS:-$tmp}"
mkdir -p "$shots"
PROVA_URL="$B" PROVA_TOKEN="$tok" PROVA_SHOTS="$shots" node web/verify.mjs
echo "app URL while running: $B/i/$tok  (server stops when verify ends; use npm run dev / start for a long-lived one)"
echo "verify OK"
