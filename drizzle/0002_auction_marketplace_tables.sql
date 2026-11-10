-- 0002_auction_marketplace_tables.sql (Postgres)
CREATE TABLE IF NOT EXISTS listings (
  id SERIAL PRIMARY KEY,
  year INTEGER NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  trim TEXT,
  mileage INTEGER NOT NULL,
  condition TEXT NOT NULL,
  title_status TEXT NOT NULL,
  location TEXT NOT NULL,
  description TEXT NOT NULL,
  image_url TEXT,
  seller_name TEXT NOT NULL,
  seller_phone TEXT,
  starting_price INTEGER NOT NULL,
  reserve_price INTEGER,
  ends_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS bids (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  bidder_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS watches (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
