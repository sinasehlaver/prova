-- ADR 0001 block 1 (2026-10-22).
-- charges.waive_kind: NULL = whole charge waived ("Tamamını iptal et": its paid part becomes alacak, the old behaviour);
--   'rest' = only the remainder forgiven ("Kalanı sil": the paid part stays a payment, no alacak). Only set with waived_at.
-- credit_settlements.kind: 'refund' = money handed back ("Geri ödendi"); 'forfeit' = alacak cleared ("Alacağı sil").
ALTER TABLE charges ADD COLUMN waive_kind TEXT CHECK (waive_kind IN ('rest'));
ALTER TABLE credit_settlements ADD COLUMN kind TEXT NOT NULL DEFAULT 'refund' CHECK (kind IN ('refund', 'forfeit'));
