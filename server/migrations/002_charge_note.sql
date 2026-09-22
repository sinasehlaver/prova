-- Adjustment charges need a human label (e.g. "Anahtar kopyası"); subscription/booking rows leave it NULL.
ALTER TABLE charges ADD COLUMN note TEXT;
