-- 0019_bid_lookup_codes.sql (Postgres)
-- "See my bids": a bidder enters the email they bid with and gets a
-- 6-digit code by email; entering the code shows their bids. No accounts,
-- no passwords — the code proves the email is theirs. Codes expire after
-- 15 minutes; a new request replaces any older code for that email.
CREATE TABLE IF NOT EXISTS bid_lookup_codes (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bid_lookup_codes_email_idx ON bid_lookup_codes (email);
