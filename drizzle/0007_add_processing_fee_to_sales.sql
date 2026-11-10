-- 0007_add_processing_fee_to_sales.sql (Postgres)
DO $$ BEGIN ALTER TABLE sales ADD COLUMN processing_fee INTEGER; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
