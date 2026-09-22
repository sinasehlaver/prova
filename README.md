# prova

Turkish-language, phone-first web app for a community sharing one rehearsal room: booking calendar, per-member billing, receipt (dekont) verification, amenity alerts, admin economics. Plan: `knowledge/atelier/community-rehearsal-room-booking.md`.

**Status: Phases 1-7 done** — self-signup + admin approval (admin bootstrap via an invite link), profile/logout, members, receipt verifier, reservations, billing + admin-recorded payments (the member self-serve dekont upload is switched off, see below), amenity alerts, economics, and deploy prep (Render + Turso, PWA manifest, admin export, cold-start/empty/error states, aesthetic pass). Nothing is deployed: see `DEPLOY.md`.

## How to run / test

Requires Node 20+ (developed on Node 24). Works on macOS, Linux and Windows — nothing here is mac-specific, except the `verify` script and `browser.mjs` (below).

```sh
npm install          # once
npm run dev          # API :4600 + Vite :4601 (proxies /api and /i); open http://127.0.0.1:4601
npm test             # node:test (login, signup/approval, role gating, migrations)
npm run verify       # tests + build + boot on a free port w/ temp DB + browser check
npm run build && npm start   # production: server serves web/dist on :4600
```

- **First boot** on an empty DB seeds an admin and prints its login link (`/i/<token>`) to the server log. Set `ADMIN_INVITE_TOKEN` to choose the token, `ADMIN_NAME` for the name, `SEED_DEMO=1` to add sample members.
- **Accounts / login**: anyone opens the app and taps **Hesap oluştur** (name + optional phone → `POST /api/signup`, public, 5/10 min/IP, max 50 waiting). That creates a **pending** account (`users.status='pending'`, `active=0`) and logs the browser in (session cookie = `users.invite_token`); it only sees the "Onay bekleniyor" screen — `/api/me` answers, every other API returns 403. An admin sees pending sign-ups first on Yönetim > Üyeler and taps **Onayla** (becomes a normal member, joined = this month) or **Reddet** (account deleted). There is no invite-link button in the UI any more and `GET /api/users` carries no tokens; the `/i/<token>` route still works (admin bootstrap link from the first-boot log; the create-member / regenerate API responses still return the token once). The admin's own row has "Giriş anahtarımı yenile" (new token, this browser stays logged in). Lost phone for an ordinary member: no self-service yet — an admin can `POST /api/users/:id/regenerate-invite` and hand over the returned link.
- **Profile**: tap your name in the top bar → sheet with name, phone (editable, `PATCH /api/me`), role, joined month, and **Çıkış yap** (`POST /api/logout` drops the cookie only; the token/link stays valid).
- **Identity is re-checked** on window focus/visibility and after any 401/403 (the cookie is shared by all tabs, e.g. opening another member's link in another tab), and the Admin tab renders only after a fresh `/me` confirms an admin; the URL hash follows the tab actually shown.
- **Config (env)**: `PORT` (4600), `DATABASE_URL` (default `file:prova.db`; Turso `libsql://…` in prod, plus **required** `DATABASE_AUTH_TOKEN`), `PUBLIC_URL` (origin printed in the first-boot admin link; defaults to Render's `RENDER_EXTERNAL_URL`), `ADMIN_INVITE_TOKEN` / `ADMIN_NAME` / `SEED_DEMO` (first boot only). On Render (`RENDER=true`) a `file:` DB is refused (ephemeral disk) unless `ALLOW_EPHEMERAL_DB=1`.

### Platform notes for `npm run verify`

`scripts/verify.sh` is a **bash** script and uses `../.claude/scripts/freeport.sh` (bash + `lsof`/node) and `../.claude/scripts/browser.mjs` (drives Chrome at `/Applications/Google Chrome.app` unless a Playwright browser is cached). That is **macOS/Linux-with-bash only**; there is no Windows equivalent yet — on Windows run `npm test` and `npm run dev` and check by hand (or use WSL). The browser step is skipped with a warning if Chrome/playwright isn't found. `PROVA_SHOTS=<dir> npm run verify` keeps the screenshots.

## Receipt verifier (Phase 2, standalone)

`server/lib/receipt.mjs` — DB-free: `extractText`, `parseAmounts`, `parseBankRef`, `sha256`, `verifyReceipt({buffer, expectedTry, existing:{hashes,bankRefs}, iban?, holderName?})` → `{status: ok|mismatch|unreadable|duplicate, diff?: {kind: under|over, paidTry, deltaTry} (only on a mismatch with exactly ONE amount found and a fine recipient), foundAmounts, expected, found, bankRef, sha256, text, message}` (Turkish message; compares in kuruş; iban OR name must appear if given). CLI (plain Node, any OS):

```sh
node receipt-check.mjs dekont.pdf 1500 [--iban TR..] [--name "Ad Soyad"]   # exit 0 ok, 1 mismatch/duplicate, 2 unreadable
node scripts/make-receipt-fixtures.mjs                                    # regenerate fixtures/receipts/*.pdf
```

**Fixtures are synthetic** (`fixtures/receipts/README.md`); real redacted dekonts are still needed before trusting the hit-rate. Image-only PDFs are `unreadable` (no OCR).

## Reservations (Phase 3)

Takvim tab: a **Gün / Hafta** toggle at the top (day strip + hourly slots, or the 7-day grid; prev/next step by the chosen unit, "Bugün" jumps back). The choice is remembered in `localStorage` key `prova.calview`; until you pick one, phones open on Gün and wide screens (>=900px) on Hafta. Bottom-sheet/dialog to book (start, duration, note, number of people) and to view/cancel. UI window is 08:00-24:00 Istanbul time. The grid polls every 12 s and on tab focus.

**Cancelling.** A member cancels their own booking with a plain confirm. An **admin cancelling someone else's booking** hits a hard gate: red dialog naming the booker + time, the admin must type the booker's first name (case/diacritic-insensitive) AND a reason (>= 5 chars) before the button arms. The API enforces the same: `DELETE /api/reservations/:id` with body `{confirm: "<first name>", reason: "<text>"}`, otherwise 400 and nothing changes. Every cancel (own = `cancel`, admin-on-other = `admin_cancel` with reason + acting admin) is written to `reservation_audit` (migration 005, in the export, `GET /api/reservations/audit` admin-only). Affected members are not notified (out of scope).

**Soft holds ("Rezerve ediliyor").** While the booking sheet is open the picked hours are held for ~2 minutes (`slot_holds`, migration 005; refreshed every 45 s, released on close/confirm/expiry, one hold per user). Other members see those hours as an amber striped "Rezerve ediliyor / X seçiyor" block (distinct from booked) and cannot pick them. `POST /api/holds {start_ms, hours}` (409 if booked or another user's live hold overlaps), `DELETE /api/holds` (own), `GET /api/holds` (others' live holds). `createReservation` also returns 409 ("Bu saat az önce başkası ... ayrıldı") when another user's live hold overlaps, and consumes the booker's own hold. It is UX only: the DB overlap check remains the real guarantee. TTL: 2 min, override with env `PROVA_HOLD_TTL_MS`. Holds are ephemeral and not exported.

- `GET /api/reservations?from=<ms>&to=<ms>` (everyone sees all non-cancelled bookings incl. booker name + `people`), `GET /api/reservations/config` (`max_hours`, `max_people`), `POST /api/reservations` `{start_ms, hours, note?, people?}` (`people` 1-20, default 1, guests need not be members; the booker pays `people` × per-person fee), `DELETE /api/reservations/:id` (booker, or admin with the hard gate below; until start), `GET /api/members` (id + name of active members, any logged-in user).
- Rules: whole-hour start, 1..`max_reservation_hours` (settings, default 4), start in the future, overlap -> 409 (`end == start` is fine). Errors are Turkish `{error}`.
- `npm run verify` also checks create / overlap 409 / boundary over the API and screenshots the calendar (`calendar*.png` with `PROVA_SHOTS`).

## Billing + receipts (Phase 4)

> **Payments are admin-operated (since 2026-09-22).** The member-facing self-serve dekont upload with automatic
> verification was beta-quality and is **switched off**: members pay by bank transfer and hand the dekont to an admin,
> who records the payment by hand. The parser is kept, but only as an *aid* — it suggests an amount, it never decides.

Ödemelerim tab (**read-only**): month switcher (join month .. current), "kalan ödenecek" card, "alacağın" card, community IBAN/holder (copy button), item list (aidat / rezervasyon / düzeltme; each with icon + text status: ✓ Ödendi, ✗ Ödenmedi, Kısmen ödendi, Muaf, İptal), a short "Ödeme nasıl yapılır?" note, and the payments an admin already recorded. Yönetim tab has sections: Üyeler (+ per-member "Ödemeler" detail: month items with checkboxes, **Ödeme kaydet** form, waive, extra charge, recorded payments, reservations) · Ödemeler (**opens on the current month and on everyone**: a "who owes what" table of every member with their outstanding for the selected month *and* their carried-over total debt, the two grand totals on top, a row click drills into that member's detail; below it the recorded payments — filter member/status, "Tüm ayların dekontlarını göster" to drop the month filter, inline `<embed>` PDF; approve/reject + note = the undo path) · Ücretler (fee editor) · Ayarlar (IBAN, holder, recipient-check toggle for the parse preview).

- Charges: subscription is materialised lazily (`ensureMonth`, idempotent) for active members from `joined_month`; ONE booking charge on the booker (`people` × the per-person fee) is inserted in the reservation-create tx and voided (unpaid only) on cancel. Every charge stores its own amount (snapshot); a fee change (`POST /api/admin/fees`, effective from a FUTURE month only) never touches existing charges.
- Member API (own data only, read-only): `GET /api/billing?month=YYYY-MM` → `{month, items[{id,kind,amount_try,status paid|unpaid|waived|voided,paid_try,remaining_try,paid_by,flag,note,reservation}], kalan, total, paid, months, receipts, pay_to, credit:{balance_try, settlements[]}}` (`kalan` = unpaid minus part-payments; `paid + kalan = total`); `GET /api/receipts/:id/pdf` (owner or admin, else 404). `POST /api/billing/receipts` is **switched off**: 401 anonymous, **403 with a Turkish reason for everyone else**.
- **Who owes what** (admin): `GET /api/admin/billing/overview?month=YYYY-MM` (default = current month) → `{month, months, users[{id, name, active, outstanding_try, debt_try}], total_outstanding_try, total_debt_try, owing_count}`. One aggregate query over all members (no per-user round trip): `outstanding_try` = the selected month, `debt_try` = every month up to the current one (unpaid items stay in their own month — debt carries over, it is never rolled forward into a new charge). An item counts as owed when it is not voided, not waived and not fully paid, for `amount_try` minus what ok receipts already applied to it — the same invariant `GET /api/billing`'s `kalan` uses. Listed members = active ones + anyone deactivated who still owes something (so the total can't hide debt); pending sign-ups never appear. Requesting the current month materialises that month's subscription charges first (`ensureMonth`), so a member who never opened their own page is still counted.
- Admin API (`/api/admin`, 403 for members): `POST users/:id/receipts?month=&charges=1,2&amount_try=&filename=&note=` with a raw `application/pdf` body (optional — no body = a payment with no dekont, e.g. cash; 5 MB cap; omit `charges` = all unpaid) → `201 {…receipt, duplicate}` — **records a payment manually**: `amount_try` is the admin's number, allocated exactly like before (oldest item first, `paid_by='admin'`). `POST receipts/parse?expected_try=` with a raw PDF body → `{status, message, amounts, found_try, suggest_try, bank_ref, duplicate}` — parse **suggestion only, stores nothing**. Plus `GET receipts?month&user_id&status`, `POST receipts/:id/approve|reject {note}` (reject = undo a recorded payment; approve = re-apply it in full), `GET users/:id/billing|receipts|reservations`, `POST users/:id/charges {month,amount_try,note}` (extra debt), `POST charges/:id/waive {waived}` (forgive debt), `POST users/:id/credit/settle {amount_try?, note?}` ("Alacağı kapat"; omit amount = all), `GET|POST fees`, `GET|PUT settings {iban,holder,requireRecipient}`.
- **Under/over payment** (the recorded amount vs what is still *outstanding* on the selected items): exact = ok. **Less** = a *part-payment*: applied to the selected items oldest first, an item turns Ödendi only once fully covered, the rest shows as **Kalan** on the item, the card and in the receipt message. **More** = items paid, the surplus first pays the month's other unpaid items, whatever is left is a **credit** ("Topluluk sana X TL borçlu") shown on the member's Ödemelerim and in the admin per-member view, where the admin records "Alacağı kapat / iade edildi" (partial or full; nothing is paid out automatically and credit is not auto-applied to future months). Money stays whole TRY; the parse *suggestion* floors the dekont amount to whole lira (1.500,50 TL suggests 1.500). Admin approve of a not-ok receipt = counts in full; reject makes its part-payment and credit stop counting. Balance is derived (migration `004_credits.sql`: `receipts.applied_try/overpaid_try`, `receipt_charges.applied_try`, `credit_settlements`), also exported. There is **no new money state**: extra debt is an adjustment charge, forgiving debt is a waive, paying credit back is a settlement.
- `npm run verify` smokes the charge, the member upload being 403, an admin-recorded part-payment over the API, member gating and the overview totals (every member listed, total = the sum of the rows), then in the browser records `enpara-1500.pdf` through the admin **Ödeme kaydet** form, checks the Ödemeler overview lists everyone and drills into a row, and screenshots `billing*.png`, `admin-overview/receipts/fees/user*.png` (`PROVA_SHOTS`). Fixtures are synthetic - see the receipt verifier notes above.

## Amenity alerts (Phase 5)

Uyarılar tab: one big button per kind (10 seeded, admin-editable on the Yönetim tab), raise = tap. Open alerts show as a sticky banner under the top bar on every tab (amber; red + "2 günden uzun süredir açık" after 48 h; always icon + text) with a green close button (`label_resolved`, e.g. "Galoş aldım"). Polls every 60 s and on focus. History (who raised / who closed, when) is paged under the buttons.

- `GET /api/alerts` (open), `GET /api/alerts/kinds`, `GET /api/alerts/history?limit=&before=<id>`, `POST /api/alerts {kind_id}` (201 new; 200 + the existing alert if that kind is already open — race-safe via the partial unique index), `POST /api/alerts/:id/close` (any member; closing twice is a no-op 200).
- Admin only: `POST /api/alerts/kinds`, `PATCH /api/alerts/kinds/:id`, `POST /api/alerts/kinds/reorder {ids}`, `DELETE /api/alerts/kinds/:id` (409 once a kind has history — no `active` column; rename instead).
- `npm run verify` smokes raise/idempotent/close over the API and screenshots `alerts.png` + `alerts-banner.png`.

## Economics (Phase 6)

Yönetim > Ekonomi (admin only): fee suggestion card, income-vs-cost chart (last 6 months: dashed bar = expected, solid bar = collected, line = cost; inline SVG with title/desc, legend, hover/focus readout and a "Tablo olarak göster" view), per-month cost list (kira, su, elektrik, internet, aidat, diğer + custom) and cost templates. Money is whole TRY.

- Suggestion (`suggestFees`, pure, `server/lib/economics.mjs`): C = average of the last 3 months' costs (incl. this month), N = members and P = booked person-slots (sum of `people` over booking charges)/month averaged over the 3 complete months before this one (falls back to this month), I = N·S + P·B. If C·(1+10%) > I: k = C·1.1/I, suggest S' = ceil50(k·S), B' = ceil50(k·B); plus subscription-only and booking-only alternatives that close the gap. Otherwise no increase. Booking income depends on usage, so it is an estimate (the card says so). "Uygula (gelecek aydan)" writes a fees row effective NEXT month via the existing `setFee`.
- Templates prefill a month lazily and once (first time the month's costs are opened; a `settings` flag `costs_prefilled:<month>` stops re-adding after you delete rows).
- API (`/api/admin`, 403 for members): `GET economics` (months[6] {month,expected,collected,cost,balance}, suggestion, fees.next), `POST economics/apply {which: combined|subscription|booking}`, `GET|POST costs`, `PATCH|DELETE costs/:id`, `GET costs?month=`, `PUT|DELETE cost-templates/:category {amount_try}`.
- `npm run verify` smokes member 403 + cost + suggestion over the API, then in the browser opens the tab, toggles the table view, applies the suggestion and screenshots `admin-economics*.png` (`PROVA_SHOTS`). Tests: `server/economics.test.mjs`.

## Deploy, PWA, export (Phase 7)

- **Deploy** (Render free web service + Turso free DB, $0): `render.yaml` + step-by-step, re-verified free-tier limits (2026-09-20) and the Fly.io fallback in `DEPLOY.md`. Not deployed yet — needs your accounts.
- **PWA**: `web/public/manifest.webmanifest` (Turkish, standalone, theme colors) + `icon-192/512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `icon.svg` (regenerate PNGs from the SVGs: `node scripts/make-icons.mjs`, needs Chrome + the workspace `browser.mjs`; PNGs are committed). No service worker on purpose.
- **Export** (admin): Yönetim > Ayarlar > "Yedek / dışa aktar", or `GET /api/admin/export?format=json[&pdf=1]` / `?format=csv` (attachment; 401/403 for non-admins). JSON = users (no invite tokens), fees, reservations (incl. `people`), attendees (legacy, empty for new bookings), charges, receipts metadata (incl. `applied_try`/`overpaid_try`; PDF as base64 only with `pdf=1`, extracted text never), receipt_charges (with `applied_try`), credit_settlements, costs, templates, settings, alert kinds + alerts, reservation_audit (cancel log). CSV = one row per charge with payer + receipt status (`;` separator, UTF-8 BOM). `npm run verify` smokes both + the served manifest/icons.
- **States**: `web/src/States.jsx` (`Skeleton`, `EmptyState`, `ErrorState` with retry, `Boot` = "Oda uyanıyor…" cold-start splash, hint after 4 s). A network/5xx failure of `/api/me` shows the retry card, never the login screen (only a 401 means logged out).

## Layout

```
server/  app.mjs (express app) · index.mjs (boot) · seed.mjs · routes/ (index.mjs = registry) · lib/ (db, auth, money, tz)
         migrations/NNN_*.sql · test-helpers.mjs (makeTestApp) · *.test.mjs
web/     Vite + React · src/tr.js (all Turkish strings) · src/styles.css (tokens, light/dark via data-theme)
scripts/ verify.sh
```
