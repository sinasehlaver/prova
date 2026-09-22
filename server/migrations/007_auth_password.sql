-- Add email and password_hash for credential login.
-- invite_token remains for backward-compat (legacy /i/ links, admin bootstrap).
-- New signups MUST provide email + password. Existing rows get NULL email/password_hash.
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN password_hash TEXT;

-- Add unique index on email (allows multiple NULLs in SQLite)
CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;