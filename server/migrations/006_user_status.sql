-- Self-signup: a new account is 'pending' (and active = 0, so every `active = 1` query - member list, subscription
-- charges, economics - ignores it) until an admin approves it. Existing rows stay 'approved'.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved'));
