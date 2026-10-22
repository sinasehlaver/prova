-- Member's own message when resubmitting a rejected dekont (shown to the admin on the pending card).
ALTER TABLE receipts ADD COLUMN member_note TEXT;
