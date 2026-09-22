-- Partial payments + overpayment credit. All whole TRY.
-- receipts.applied_try   : part of the dekont counted toward charges (NULL = legacy/non-ok row; ok rows always set it).
-- receipts.overpaid_try  : whole-TRY surplus over the selected charges = the community owes it back (only counts while status='ok').
-- receipt_charges.applied_try : how much of that receipt went to that charge (oldest first); a charge is 'paid' only once fully covered.
-- credit_settlements     : admin marks (part of) the owed credit as refunded/settled. Balance is derived, never stored:
--   owed = SUM(overpaid_try of ok receipts) + SUM(applied_try on voided/waived charges) - SUM(settlements)
ALTER TABLE receipts ADD COLUMN applied_try INTEGER;
ALTER TABLE receipts ADD COLUMN overpaid_try INTEGER NOT NULL DEFAULT 0;
ALTER TABLE receipt_charges ADD COLUMN applied_try INTEGER;
CREATE TABLE credit_settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_try INTEGER NOT NULL CHECK (amount_try > 0),
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_credit_settlements_user ON credit_settlements(user_id);
-- Existing ok receipts were exact matches: they applied exactly what they expected.
UPDATE receipts SET applied_try = expected_try WHERE status = 'ok' AND applied_try IS NULL;
