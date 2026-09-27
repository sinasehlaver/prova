-- New role 'listener': pays the monthly subscription fee like a normal member (billing/ensureMonth already
-- treats every non-bootstrap user the same way, so no billing code change needed) but cannot create
-- reservations or holds (enforced in server/lib/reservations.mjs and routes/reservations.mjs, same shape
-- as the bootstrap-observer 403). Unlike the bootstrap observer it is NOT hidden and IS billed - it shows
-- up in Üyeler/Ödemeler like any member. The `role` CHECK is on the original 001_init column, so SQLite
-- needs a table rebuild (can't ALTER a CHECK in place) - same pattern as 008_receipt_pending.sql.
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','listener')),
  invite_token TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  joined_month TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved')),
  email TEXT,
  password_hash TEXT
);
INSERT INTO users_new SELECT id, name, phone, role, invite_token, active, joined_month, created_at, status, email, password_hash FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;
