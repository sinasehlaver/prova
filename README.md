# Yüzen Oda

A phone-first web app for a community that shares one rehearsal room. It handles
booking the room, splitting the monthly rent + per-booking fees fairly between
members, verifying bank transfer receipts, and raising "we're out of X" alerts —
all in Turkish, all from a phone.

**Status:** feature-complete (phases 1-7), not deployed yet. Everything below works
locally; see [Deploying](#deploying) to put it online.

## Quick start

Requires Node 20+ (developed on Node 24). Works on macOS, Linux and Windows —
nothing here is Mac-specific except the browser-driven `npm run verify` check
(see [Testing](#testing)).

```sh
npm install
./start.sh
```

`./start.sh` is the recommended one-command way to run both the API and the
web app together — it starts the API on `:4600` and the web app on `:4601`,
and Ctrl+C cleanly stops both (and their child processes, e.g. vite's esbuild
service) with nothing left running or listening. macOS/Linux only (it's a bash
script using `trap`); on Windows, or if you'd rather run/stop each process by
hand, use the equivalent two-command form instead:

```sh
npm install
npm run dev
```

Either way this starts the API on `:4600` and the web app on `:4601`. Open
**http://localhost:4601**.

On the very first run, with an empty database, the server creates an admin
account and prints a login link to the terminal:

```
Admin login: http://localhost:4601/i/<token>
```

Open that link in your browser — that's you, logged in as admin. From there you
can approve new members, set fees, and configure the room.

That first account is an **observer admin**: nobody else sees it in any list, it
is never charged dues, and it can't book the room. It can still see every admin
screen and promote members to admin. If you also play in the room, sign up a
normal account for yourself and make it an admin. Details, plus how to check it
on a live Render + Turso deploy: [`BOOTSTRAP-ADMIN.md`](./BOOTSTRAP-ADMIN.md).

Want the app pre-filled with a handful of sample members and a month of demo
data instead of starting empty? Run `SEED_DEMO=1 npm run dev` the first time.

## Using the app

Everything below is a walkthrough of what a member or admin actually does in
the app — not an API reference (see `.claude/rules/prova.md` in the workspace
for that level of detail).

### Joining

1. Open the app and tap **Hesap oluştur** (Create account) — just a name and
   optional phone number.
2. You're in immediately, but your account is **pending** until an admin
   approves you. You'll see an "Onay bekleniyor" (Awaiting approval) screen in
   the meantime.
3. An admin approves you from **Yönetim → Üyeler** (a red badge shows there's
   someone waiting). Once approved, you're a full member.

There's no email/password — your session is a link tied to your device. If you
lose access (new phone, cleared cookies), ask an admin to regenerate your
invite link from your member page.

### Booking the room

Go to the **Takvim** (Calendar) tab.

- Switch between a **Gün** (day) view and a **Hafta** (week) view.
- Tap a free slot to book it, or drag across several hours. Pick how many
  people are coming — the cost is per-person, and guests don't need to be
  members.
- While you have the booking sheet open, that time slot is held for ~2 minutes
  so nobody else can grab it out from under you.
- To cancel your own booking, open it and confirm. Admins can cancel *other*
  members' bookings too, but only after typing the booker's name and a reason
  — that gets logged.

### Paying your dues

Go to the **Ödemelerim** (My payments) tab. It shows what you owe this month
(monthly dues + any bookings you made), what's already been paid, and the
community's bank details (IBAN, tap to copy).

Payment itself happens outside the app: transfer the money, then either **hand
the receipt (dekont) to an admin** or **upload it yourself** from the
Ödemelerim tab. Either way, nothing is automatic: an admin has to open it and
type in the amount before it counts toward your balance (an uploaded dekont
sits as "İnceleniyor"/"Onay bekliyor" until then) — verifying transfers
automatically turned out to be unreliable, so a human always decides. If you
paid more or less than expected, the app tracks the difference (as a "Kalan"
balance owed, or a credit for next time) automatically once the admin records it.

You can also flip forward to **future months** (up to 12 ahead) with the month
arrows, even before anything is booked: you'll see bookings you already made
for that month plus the expected monthly dues ("Planlanan aidat" — only an
estimate until the month starts). If the community owes you money (a credit
from overpaying), the page shows how much of that month it would cover, e.g.
"next month's dues are already covered by your credit". That's a preview; it
turns into "paid" once an admin applies the credit.

### Raising an alert

Something out of stock or broken in the room (picks, cables, the amp)? Go to
**Uyarılar** (Alerts) and tap the relevant button. It shows up for everyone as a
small icon next to the app name at the top of every tab (tap it to see what it is
and resolve it) until someone marks it resolved. Alerts open more than 2 days
turn red. The **Uyarılar** tab itself still lists every open/past alert in full.

### Admin tools

Everything above, plus, under **Yönetim** (Admin):

- **Üyeler** — approve/reject new sign-ups, see every member, regenerate a
  lost invite link.
- **Ödemeler** — who owes what, this month and total, across the whole
  community at a glance (the observer account created at first boot isn't a
  member: it's never billed and isn't counted here or in Ekonomi); drill into any member to waive a charge, add an
  extra one (**Ek ücret ekle**), then record a payment (**Ödeme kaydet**). The
  payment form is a draft until you press **Ödemeyi onayla**: tick which open
  items it covers, type the amount actually paid, and it shows live what's
  left to pay or what the community will owe the member; a dekont PDF is
  optional (cash is fine). One payment can cover items from other months too
  (older debt, next month's bookings, or prepaying next month's dues, listed
  under "Diğer aylar"), and **Alacaktan öde** spends the member's existing
  credit on the ticked items instead of new money. Once saved it becomes a read-only green
  "Kaydedildi" card: covered items, their total, the paid amount, the result,
  and the PDF if there is one. Member-uploaded dekonts show up as the same
  kind of draft ("Onay bekliyor") — pick the items + amount and approve, or
  reject with a reason.
- **Ücretler** — set the monthly dues and per-person booking fee (changes
  apply from next month, never retroactively).
- **Ekonomi** — income vs. cost chart for the last 6 months, and a suggested
  fee increase if costs have outpaced what's coming in.
- **Uyarı türleri** — add/edit/reorder the alert buttons.
- **Ayarlar** — the community's IBAN and account holder name, plus a full
  data export (JSON/CSV) for backups.

## Testing

```sh
npm test             # unit + integration tests (node:test)
npm run verify        # tests + production build + boot the app + a real browser smoke-test
```

`npm run verify` is the one command to run before trusting a change — it
builds the app, boots it against a throwaway database, hits the API, and
drives the UI in a real Chrome window (light + dark, phone + desktop widths).
Screenshots aren't kept by default; set `PROVA_SHOTS=<dir>` to save them.

The browser part of `verify` needs macOS or Linux with `bash` + Chrome
installed; on Windows, run `npm test` and `npm run dev` and check the UI by
hand (or use WSL).

## Deploying

Not deployed yet. [`DEPLOY.md`](./DEPLOY.md) walks through the $0 setup
(Render for hosting, Turso for the database) end to end.

## Extra: the receipt verifier, standalone

The bank-transfer-receipt parser (the app no longer uses it to suggest an
amount; it only keeps the dekont's bank ref for duplicate warnings) also works
as a plain CLI, independent of the app:

```sh
node receipt-check.mjs dekont.pdf 1500 [--iban TR..] [--name "Ad Soyad"]
```

Exits `0` if the receipt matches the expected amount, `1` on a mismatch or
duplicate, `2` if the PDF can't be read (e.g. it's a scanned image).

## Project layout

```
server/   Express API — routes/ (one file per feature), lib/ (db, auth, money, billing, ...),
          migrations/ (schema), *.test.mjs (tests live next to the code they test)
web/      React + Vite frontend — src/tr.js has every user-facing string (Turkish)
scripts/  verify.sh — the one entrypoint for the full check described above
```
