# The bootstrap admin (observer account) — check & fix on Render + Turso

## What it is

The **bootstrap admin** is the first user the app created: the account behind the
`First boot — admin login link: …/i/<token>` line in the Render log. The app
finds it by one rule only: **the user with the lowest `id`** in the `users`
table. No flag or column marks it.

Since 2026-09-23 that account is an **observer**, not a member:

| | Bootstrap admin | Any other admin (promoted later) |
|---|---|---|
| Shown in Üyeler / Ödemeler / member lists to others | **no** (it still sees itself) | yes |
| Name on alerts / cancel audit | shown as "Yönetici" | real name |
| Monthly dues (aidat), extra charges | **never** | yes |
| Counted in Ödemeler totals, Ekonomi income / member count | **no** | yes |
| Can make a reservation | **no** (403, button hidden) | yes |
| Can see every admin screen, export, audit | yes | yes |
| Can approve members, promote/demote admins | yes | yes |
| Can be demoted / deactivated / have its link reset by another admin | **no** (it's a 404 to them) | yes |

**What's at stake:** the bootstrap account can't book the room and never pays.
If you've been using the first-boot link as **your own** account (booking and
paying dues as a band member), you are now that observer.

## 1. Tools (Turso CLI, from DEPLOY.md §1)

```sh
turso auth login                 # opens the browser; once per machine
turso db list                    # your DB name, e.g. "prova"
turso db shell prova             # interactive SQL prompt (.quit to leave)
turso db shell prova "SELECT 1"  # or run one query and exit
```

macOS / Linux: `brew install tursodatabase/tap/turso`, or
`curl -sSfL https://get.tur.so/install.sh | bash`. Windows: use WSL. Without the
CLI, run the same SQL in the turso.tech dashboard → your database → **Shell / SQL console**.

## 2. Check who the bootstrap admin is right now

```sh
turso db shell prova "SELECT id, name, email, role, active, status, joined_month FROM users ORDER BY id LIMIT 5"
```

The **first row** is the bootstrap admin. It's usually `id 1`, named `Yönetici`
(or whatever `ADMIN_NAME` was set to on Render), with no email.

Without the CLI: log in as an admin → Yönetim → Ayarlar → **Yedek / dışa aktar**
(JSON). The `users` list in the file is sorted by id, so the first entry is the
bootstrap admin. The export is a full backup, so it's listed there too.

Also check whether it already has money or bookings from before this change.
These were created while it still counted as a member:

```sh
turso db shell prova "SELECT id, month, kind, amount_try, paid_receipt_id, waived_at, voided_at FROM charges WHERE user_id = (SELECT MIN(id) FROM users)"
turso db shell prova "SELECT id, start_ms, people, cancelled_at FROM reservations WHERE booker_id = (SELECT MIN(id) FROM users)"
```

Old charges on this account no longer count toward Ödemeler or Ekonomi totals.
They still show on its own **Ödemelerim** page. To clear them, log in as the
bootstrap admin and go to Yönetim → Üyeler → your own row → Ödemeler. On each
unpaid item, use **Muaf tut** (waive). Cancel any future bookings from the calendar.

## 3. Is it the right person?

On a normal deploy it can't be a random member. The seed only runs when the
`users` table is empty, and it inserts the admin **before** anyone can sign up.
So the lowest id is always the first-boot link, never a signup. The only
question is **how you use that link**:

**A. The bootstrap account is just an admin/observer login (the intended setup).**
Nothing to change. If you're also a member, you need a second, normal account
(see B).

**B. You've been using the bootstrap link as your everyday member account, and
you want to book and pay.** Don't try to move the "lowest id" to someone else.
Keep the bootstrap account as the observer and make yourself a normal account:

1. In a **different browser / private window**, open the site → **Hesap oluştur**.
   Sign up with your real name and email.
2. In the bootstrap browser: Yönetim → Üyeler → approve that signup, then set its
   role to **Yönetici** (admin).
3. Use the new account day to day. It's a full admin that books and pays like
   anyone else. Keep the bootstrap link somewhere safe as the break-glass
   observer login.

This needs no SQL. B works whether the database is fresh or full of real data.

**C. The database is brand new with no real data yet, and you want to start
over.** You can wipe it and let the seed run again:
`turso db destroy prova` → `turso db create prova` → put the new URL and token
into Render (DEPLOY.md §1–2) → redeploy → take the new first-boot link from the
log. Only do this before members and payments exist. It deletes everything.

### What NOT to do

- **Don't change `id` values** (e.g. `UPDATE users SET id = …`). Charges,
  receipts, reservations, alerts, holds and the audit log all point at
  `users.id`. Renumbering breaks those links or pins money on the wrong person.
- **Don't delete the bootstrap row.** The next-lowest id, a real member, would
  silently become the hidden, unbilled observer.

### If you truly need "a different existing person is the observer"

For example, a real member with bookings and payments should become the
hidden observer instead of the seeded account. That **can't be done safely from
the Turso shell**. The rule "lowest id = observer" is fixed in code. The real fix
is a small code change: mark the observer explicitly with an env var on Render
(e.g. `OBSERVER_USER_ID=7`) or a new `users.is_observer` column set by a
migration. Then the choice stops depending on signup order. Ask for it as a
follow-up task. Until then, option B covers the normal case.

## 4. Lost the bootstrap link?

```sh
turso db shell prova "UPDATE users SET invite_token = '<new-long-random-token>' WHERE id = (SELECT MIN(id) FROM users)"
```

Generate the token with `openssl rand -base64 24 | tr '+/' '-_' | tr -d '='`, then open
`https://<your-service>.onrender.com/i/<new-long-random-token>`. Any old sessions of that account stop working.
