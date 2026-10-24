-- ADR 0001 #6/#10: a month with no aidat because the member was passive (or joined/reactivated on day 16+) is a VOIDED
-- subscription row marked void_kind='passive' ("Aidat · Pasif"). The row also blocks re-creation (uq_charges_subscription).
ALTER TABLE charges ADD COLUMN void_kind TEXT CHECK (void_kind IN ('passive'));
-- First month without aidat of the current passive stretch (NULL while active, or for members made passive before this).
ALTER TABLE users ADD COLUMN passive_from TEXT;
