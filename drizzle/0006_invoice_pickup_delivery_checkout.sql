-- 0006_invoice_pickup_delivery_checkout.sql (Postgres)
DO $$ BEGIN ALTER TABLE sales ADD COLUMN invoice_sent_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN invoice_paid_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN buyer_pickup_confirmed_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN seller_pickup_confirmed_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN payout_released_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN delivery_requested_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN delivery_address TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE sales ADD COLUMN delivery_notes TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
