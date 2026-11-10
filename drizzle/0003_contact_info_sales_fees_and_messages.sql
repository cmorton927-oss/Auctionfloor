-- 0003_contact_info_sales_fees_and_messages.sql (Postgres)
DO $$ BEGIN ALTER TABLE listings ADD COLUMN seller_email TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE listings ADD COLUMN image_path TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE bids ADD COLUMN bidder_phone TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE bids ADD COLUMN bidder_email TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL UNIQUE REFERENCES listings(id),
  status TEXT NOT NULL,
  winner_name TEXT,
  winner_phone TEXT,
  winner_email TEXT,
  amount INTEGER,
  buyer_fee INTEGER,
  seller_fee INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  sale_id INTEGER REFERENCES sales(id),
  recipient_role TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_phone TEXT,
  recipient_email TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
