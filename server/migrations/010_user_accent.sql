-- Per-user UI accent color (own choice, own account only). 'brick' = the original orange-brick default.
ALTER TABLE users ADD COLUMN accent TEXT NOT NULL DEFAULT 'brick' CHECK (accent IN ('brick','blue','green','purple','pink','yellow','gray'));
