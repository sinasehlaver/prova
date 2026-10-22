-- Portion of a receipt paid out of the member's existing credit ("Alacağı hesaba kat"). overpaid_try stays the NET
-- (new surplus minus credit used), so creditBalance (sum of overpaid_try over ok receipts) is unchanged.
ALTER TABLE receipts ADD COLUMN credit_try INTEGER NOT NULL DEFAULT 0;
