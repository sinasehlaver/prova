-- Re-enable member self-serve dekont upload (admin-approval-only, decided 2026-09-22 - reverses the earlier
-- "switched off" decision from the same day). A member-submitted receipt needs a status that means "nobody has
-- looked at this yet, it counts toward nothing" - the existing CHECK only had ok/mismatch/unreadable/duplicate,
-- so the column needs a rebuild (SQLite can't ALTER a CHECK constraint in place).
-- 'pending' rows are excluded from every money calculation by construction: COVERED_SQL / outstandingOverview only
-- ever sum over status='ok', and a pending row starts with no receipt_charges rows at all. An admin turns it into
-- 'ok' (approve, allocates like recordPayment) or 'mismatch' (reject, same as any other rejected receipt).
CREATE TABLE receipts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  month TEXT NOT NULL,
  filename TEXT,
  pdf BLOB,
  sha256 TEXT NOT NULL UNIQUE,
  text TEXT,
  amounts_json TEXT,
  bank_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','mismatch','unreadable','duplicate','pending')),
  expected_try INTEGER,
  found_try INTEGER,
  uploaded_at INTEGER NOT NULL,
  admin_note TEXT,
  applied_try INTEGER,
  overpaid_try INTEGER NOT NULL DEFAULT 0
);
INSERT INTO receipts_new SELECT id, user_id, month, filename, pdf, sha256, text, amounts_json, bank_ref, status, expected_try, found_try, uploaded_at, admin_note, applied_try, overpaid_try FROM receipts;
DROP TABLE receipts;
ALTER TABLE receipts_new RENAME TO receipts;
