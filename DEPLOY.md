# Deploy prova ($0): Render free web service + Turso free database

Nothing here has been deployed yet — these steps need **your** Render and Turso accounts. Limits re-verified on **2026-09-20** from the vendor pages linked in "Limits" below; re-check before relying on them.

## Limits (re-verified 2026-09-20; unchanged vs the plan)

| | Value | Source |
|---|---|---|
| Render free web service | spins down after **15 min** without inbound traffic; wake-up **about one minute** (Render shows its own loading page meanwhile); **no persistent disk**; **750 free instance hours / workspace / month** (one always-on service = ~744 h, fits) | https://render.com/docs/free |
| Turso free plan | **100 databases, 5 GB, 500 M rows read / month, 10 M rows written / month, 1 day point-in-time restore**, $0, no card to start | https://turso.tech/pricing |
| Fly.io (fallback) | shared-cpu-1x 256 MB ≈ **$2.02/month**; volumes **$0.15/GB-month**; no free tier listed on the pricing page (a separate free-trial page exists) | https://fly.io/docs/about/pricing/ |
| Render default Node | 24.x for services created on/after 2026-09-17; unbounded `engines` ranges resolve to "latest" → we pin `NODE_VERSION=24` | https://render.com/docs/node-version |

Nothing changed vs the plan, so **Option A is workable**. Usage sanity check: a 10-member room does a few thousand row reads/writes a month, ~5 orders of magnitude under the Turso caps. The real cost is the ~1 min cold start after 15 idle minutes (the app shows "Oda uyanıyor…" once it can render; before that Render's own loading page shows). Unverified: whether Render currently asks for a payment method to create a free web service — you will find out at signup.

**If Option A ever stops working** (Render drops the free tier, Turso changes limits): use **Fly.io** (~$2–7/mo). Same code: `DATABASE_URL=file:/data/prova.db`, no token, a Fly volume mounted at `/data` (`fly launch`, `fly volumes create data --size 1`, one machine only — the reservation mutex is in-process), `PORT=8080`. The Render-only guard in `db.mjs` keys on the `RENDER` env var, so Fly is unaffected.

## 1. Turso database

```sh
brew install tursodatabase/tap/turso        # macOS; Linux: curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup                           # or: turso auth login   (Windows: use WSL, or create the DB in the web dashboard instead)
turso db create prova --location fra        # if your CLI version wants groups: `turso db create prova` then set the group's location in the dashboard
turso db show prova --url                   # -> libsql://prova-<you>.turso.io   = DATABASE_URL
turso db tokens create prova                # -> long token                       = DATABASE_AUTH_TOKEN
```

(Flags drift between CLI versions: `turso db create --help`. The web dashboard at turso.tech can do all of it.) The schema is created by the app itself on first boot (numbered migrations in `server/migrations/`), you don't run any SQL.

## 2. Render web service

1. Put the repo on GitHub (this folder is **not** a git repo yet — `git init` + push is your call; Render deploys from a Git remote). Don't commit `prova.db*` or `.env` (`.gitignore` covers them).
2. Render dashboard → **New → Blueprint** → pick the repo → it reads `render.yaml` (free plan, Frankfurt, build `npm ci --include=dev && npm run build`, start `npm start`, health check `/api/health`).
   No Blueprint? **New → Web Service**, Runtime Node, same build/start commands, plan **Free**, add the env vars below.
3. Fill the prompted env vars:

| Var | Value |
|---|---|
| `DATABASE_URL` | `libsql://prova-<you>.turso.io` (required) |
| `DATABASE_AUTH_TOKEN` | the Turso token (required; the app refuses to start without it for a `libsql://` URL) |
| `NODE_VERSION` | `24` (already in `render.yaml`) |
| `ADMIN_INVITE_TOKEN` | optional: a token you choose for the first admin (letters, digits, `-`, `_`; ≥ 24 chars: `openssl rand -base64 24 | tr '+/' '-_' | tr -d '='`). Only used when the users table is empty |
| `ADMIN_NAME` | optional, default `Yönetici` |
| `PUBLIC_URL` | optional: your custom domain (`https://prova.example.com`), only changes the URL printed in the first-boot log |
| `PORT` | leave unset — Render injects it, the server reads it |
| `SEED_DEMO` | **do not set** (adds sample members) |

`RENDER=true` and `RENDER_EXTERNAL_URL` are set by Render itself. With `RENDER=true` the server **refuses to boot on a `file:` database** (Render's disk is wiped on every spin-down; that would silently lose bookings and payments). Override only for a throw-away test with `ALLOW_EPHEMERAL_DB=1`.

## 3. First login (admin bootstrap)

On the very first boot (empty database) the server seeds the admin, alert kinds, default fee (1500 aidat / 500 rezervasyon) and prints **one log line**:

```
First boot — admin login link: https://prova-xxxx.onrender.com/i/<token>  (regenerate from the Members page: "Giriş anahtarımı yenile")
```

Find it in Render → your service → **Logs** (it is printed once; if you set `ADMIN_INVITE_TOKEN` the link is simply `https://<your-service>.onrender.com/i/<that token>`). Open it on your phone: it sets a ~400-day cookie. Then:

1. Yönetim → Üyeler → **Giriş anahtarımı yenile** on your own row (regenerates your token so the one in the logs dies; this browser stays logged in). Members don't need links: they open the site and tap **Hesap oluştur**, then you approve them under Yönetim → Üyeler → *Onay bekleyenler*.
2. Yönetim → Ayarlar → enter the community **IBAN + holder**. Yönetim → Ücretler → set fees. Ekonomi → add monthly costs.

Lost the admin link *and* the log line is gone? Reset it straight in the database: `turso db shell prova "UPDATE users SET invite_token='<new-long-token>' WHERE id = 1"` then open `/i/<new-long-token>`.

## 4. Backups

Turso free keeps 1 day of point-in-time restore only. Insurance for the money records: **Yönetim → Ayarlar → Yedek / dışa aktar** downloads a JSON (all tables incl. receipt metadata; invite tokens are omitted) and a charges CSV (`;`-separated, UTF-8 BOM, opens in Turkish Excel). Optional checkbox includes receipt PDFs as base64 (big). Do it monthly. It is a *read* backup — there is no import/restore tool; restoring means loading rows by hand or via Turso's own restore.

## 5. Install as an app

The app ships a web manifest + icons (`web/public/manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png`). iPhone: Safari → Paylaş → **Ana Ekrana Ekle**. Android/Chrome: menu → **Uygulamayı yükle**. There is deliberately **no service worker**, so it needs a connection (and a wake-up after idle) — offline use wasn't a goal.

## Try the production build locally (no accounts)

```sh
npm run build && PORT=4700 DATABASE_URL=file:/tmp/prova-try.db npm start     # macOS/Linux; on Windows PowerShell: $env:PORT=4700; $env:DATABASE_URL="file:prova-try.db"; npm start
```

## Gotchas

- Single instance only (in-process mutex serialises writes). Don't scale the Render service past 1.
- Cold start = first request after 15 min idle takes ~1 min. Members reopening the PWA see Render's loading page, then "Oda uyanıyor…", then the app. A cron pinger would defeat the sleep but burns instance hours (750/mo cap ≈ 31 days × 24 h, so it just fits); not configured.
- The Turso path (`libsql://` + token) is covered by a unit test of the option wiring only (`server/deploy.test.mjs`) — it has **not** been run against a real Turso database. First deploy = first real test: check the Render log for migration errors.
