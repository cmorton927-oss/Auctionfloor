-- 0011_no_mechanical_issues.sql (Postgres)
-- Records the seller's confirmation, required when a listing's condition is
-- "Runs & drives", that the vehicle has no mechanical issues. Shown on the
-- listing detail page so bidders can see the seller confirmed it.
DO $$ BEGIN ALTER TABLE listings ADD COLUMN no_mechanical_issues_confirmed BOOLEAN NOT NULL DEFAULT FALSE; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
