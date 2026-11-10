-- 0005_sale_access_token.sql (Postgres)
DO $$ BEGIN ALTER TABLE sales ADD COLUMN access_token TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
