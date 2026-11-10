-- 0008_stripe_checkout_fields.sql (Postgres)
DO $$ BEGIN ALTER TABLE sales ADD COLUMN stripe_checkout_session_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN stripe_checkout_url TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN stripe_payment_intent_id TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN stripe_payment_status TEXT DEFAULT 'not_started'; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN stripe_livemode BOOLEAN; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN stripe_checkout_created_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN stripe_last_checked_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
