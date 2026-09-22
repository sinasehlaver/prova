-- Booking fee = people x per-person fee, charged to the booker (no per-member attendee list any more).
-- reservation_attendees stays in the schema (old exports/rows) but is no longer written.
ALTER TABLE reservations ADD COLUMN people INTEGER NOT NULL DEFAULT 1;
UPDATE reservations SET people = MAX(1, (SELECT COUNT(*) FROM reservation_attendees a WHERE a.reservation_id = reservations.id));
