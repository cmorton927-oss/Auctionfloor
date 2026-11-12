-- 0018_verified_bidders.sql (Postgres)
-- $10 refundable bidder deposits: before their first bid, a bidder pays a
-- $10 deposit through a manual-capture Stripe Checkout Session. The $10
-- is authorized (proving the card is good) but never captured, so the
-- hold releases automatically and no fee is charged. Once verified, the
-- email never needs to deposit again.
CREATE TABLE IF NOT EXISTS verified_bidders (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  stripe_checkout_session_id TEXT,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
