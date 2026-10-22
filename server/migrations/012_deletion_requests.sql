-- Member asks admins to delete (cancel) their own past reservation. One pending request per reservation.
CREATE TABLE deletion_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id),
  requester_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at INTEGER NOT NULL,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at INTEGER
);
CREATE UNIQUE INDEX uq_delreq_pending ON deletion_requests(reservation_id) WHERE status = 'pending';
CREATE INDEX idx_delreq_status ON deletion_requests(status, created_at);
