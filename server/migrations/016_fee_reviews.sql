-- ADR 0001 #9: a fee change no longer re-prices existing items silently. Each affected item (subscription / booking of
-- that month whose price differs from the new fee) gets an open review row; the admin applies the new price or keeps
-- the old one ("Etkilenen kalemler"). Undecided rows keep the old price and wait. new_try = price under the new fee.
CREATE TABLE fee_reviews (
  id INTEGER PRIMARY KEY,
  charge_id INTEGER NOT NULL REFERENCES charges(id),
  new_try INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  decision TEXT CHECK (decision IN ('apply', 'keep'))
);
CREATE UNIQUE INDEX uq_fee_reviews_open ON fee_reviews(charge_id) WHERE resolved_at IS NULL;
