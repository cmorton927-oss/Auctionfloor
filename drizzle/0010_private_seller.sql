-- 0010_private_seller.sql (Postgres)
-- Lets a seller stay private during the auction: their real name is stored
-- but public listing responses show "Private seller" instead. The winning
-- buyer still learns the seller's real name and contact info through the
-- code-gated Messages checkout and the win message.
DO $$ BEGIN ALTER TABLE listings ADD COLUMN private_seller BOOLEAN NOT NULL DEFAULT FALSE; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
