-- 0012_buy_now_price.sql (Postgres)
-- Optional seller-set "Buy Now" price. While the auction is live, a buyer
-- can end it early by paying this price; the sale then finalizes exactly
-- like a won bid (invoice + buyer fee + administrative fee, Stripe
-- checkout, pickup confirmations before seller payout).
DO $$ BEGIN ALTER TABLE listings ADD COLUMN buy_now_price INTEGER; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
