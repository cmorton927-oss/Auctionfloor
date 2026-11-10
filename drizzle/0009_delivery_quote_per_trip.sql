-- 0009_delivery_quote_per_trip.sql (Postgres)
DO $$ BEGIN ALTER TABLE sales ADD COLUMN delivery_quote_cents INTEGER; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN delivery_quoted_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN delivery_buyer_agreed_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN delivery_seller_agreed_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
-- Owner login tables (new in the Render port; replace Muse viewer identity)
CREATE TABLE IF NOT EXISTS owner_users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS owner_sessions (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  owner_user_id INTEGER NOT NULL REFERENCES owner_users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
