-- Reservation audit trail (who cancelled whose booking, and why) + short-lived soft holds on slots.

-- Every cancel is recorded. `admin_cancel` = an admin cancelled ANOTHER member's booking (hard-gated: typed confirm + reason).
CREATE TABLE reservation_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id),
  action         TEXT NOT NULL CHECK (action IN ('cancel', 'admin_cancel')),
  actor_id       INTEGER NOT NULL REFERENCES users(id),
  booker_id      INTEGER NOT NULL REFERENCES users(id),
  reason         TEXT,
  start_ms       INTEGER NOT NULL,
  end_ms         INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_audit_reservation ON reservation_audit(reservation_id);
CREATE INDEX idx_audit_booker ON reservation_audit(booker_id);

-- Soft hold: "X is choosing these hours" while the booking sheet is open. At most one hold per user (a new one replaces
-- the old); expires_at = ms epoch, expired rows are ignored everywhere and pruned on write. Ephemeral: not exported.
CREATE TABLE slot_holds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id),
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_holds_range ON slot_holds(start_ms, end_ms);
