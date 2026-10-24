-- ADR 0001 #8: alacak that was already spent and then taken back (payment deleted / undone) never stays negative: it
-- becomes a "Harcanan alacak" adjustment charge of that amount, flagged credit_fix=1. creditBalance adds the flagged
-- charges' amounts back (unless voided), so alacak returns to 0 while the debt is a normal, payable / waivable item.
ALTER TABLE charges ADD COLUMN credit_fix INTEGER NOT NULL DEFAULT 0;
