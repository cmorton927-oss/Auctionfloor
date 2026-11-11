-- 0013_seller_zip_code.sql (Postgres)
-- Mandatory seller ZIP code on every listing. AuctionFloor is local to the
-- 423 area: listings must be within 250 miles of Chattanooga 37406 (checked
-- server-side at creation; see server/geo.js). Older rows predate the rule
-- and may have a NULL zip.
DO $$ BEGIN ALTER TABLE listings ADD COLUMN zip_code TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
