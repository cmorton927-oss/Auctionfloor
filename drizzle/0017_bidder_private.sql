-- 0017_bidder_private.sql (Postgres)
-- Private bidding: a bidder can choose to bid privately, in which case
-- public views show only their initials instead of their full name.
-- The seller and owner still see the real name (win messages, invoice,
-- checkout), which read the stored bidder_name directly.
ALTER TABLE bids ADD COLUMN IF NOT EXISTS bidder_private BOOLEAN NOT NULL DEFAULT FALSE;
