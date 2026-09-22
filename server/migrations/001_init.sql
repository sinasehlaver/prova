-- Full data model (plan Step 2). Money columns *_try are INTEGER whole TRY.
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  invite_token TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  joined_month TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE fees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  effective_from TEXT NOT NULL,
  subscription_try INTEGER NOT NULL,
  booking_try INTEGER NOT NULL
);

CREATE TABLE reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booker_id INTEGER NOT NULL REFERENCES users(id),
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  note TEXT,
  cancelled_at INTEGER,
  CHECK (end_ms > start_ms)
);
CREATE INDEX idx_reservations_start ON reservations(start_ms);

CREATE TABLE reservation_attendees (
  reservation_id INTEGER NOT NULL REFERENCES reservations(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (reservation_id, user_id)
);

CREATE TABLE receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  month TEXT NOT NULL,
  filename TEXT,
  pdf BLOB,
  sha256 TEXT NOT NULL UNIQUE,
  text TEXT,
  amounts_json TEXT,
  bank_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','mismatch','unreadable','duplicate')),
  expected_try INTEGER,
  found_try INTEGER,
  uploaded_at INTEGER NOT NULL,
  admin_note TEXT
);

CREATE TABLE charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  month TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('subscription','booking','adjustment')),
  amount_try INTEGER NOT NULL,
  reservation_id INTEGER REFERENCES reservations(id),
  voided_at INTEGER,
  waived_at INTEGER,
  paid_receipt_id INTEGER REFERENCES receipts(id),
  paid_by TEXT CHECK (paid_by IN ('auto','admin'))
);
CREATE UNIQUE INDEX uq_charges_subscription ON charges(user_id, month) WHERE kind = 'subscription';
CREATE INDEX idx_charges_user_month ON charges(user_id, month);

CREATE TABLE receipt_charges (
  receipt_id INTEGER NOT NULL REFERENCES receipts(id),
  charge_id INTEGER NOT NULL REFERENCES charges(id),
  PRIMARY KEY (receipt_id, charge_id)
);

CREATE TABLE alert_kinds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label_problem TEXT NOT NULL,
  label_resolved TEXT NOT NULL,
  icon TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind_id INTEGER NOT NULL REFERENCES alert_kinds(id),
  raised_by INTEGER NOT NULL REFERENCES users(id),
  raised_at INTEGER NOT NULL,
  closed_by INTEGER REFERENCES users(id),
  closed_at INTEGER
);
CREATE UNIQUE INDEX uq_alerts_open ON alerts(kind_id) WHERE closed_at IS NULL;

CREATE TABLE costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL,
  category TEXT NOT NULL,
  amount_try INTEGER NOT NULL,
  note TEXT
);
CREATE INDEX idx_costs_month ON costs(month);

CREATE TABLE cost_templates (
  category TEXT PRIMARY KEY,
  amount_try INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
