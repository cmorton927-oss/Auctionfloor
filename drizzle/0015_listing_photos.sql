-- 0015_listing_photos.sql (Postgres)
-- Multiple photos per listing. One row per photo, ordered by position
-- (position 0 is the main/cover photo shown on the listing card).
-- Backfills each existing listing's single photo as position 0, so
-- listings created before this change keep working in the gallery.
CREATE TABLE IF NOT EXISTS listing_photos (
  id SERIAL PRIMARY KEY,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  image_path TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_listing_photos_listing ON listing_photos(listing_id);
INSERT INTO listing_photos (listing_id, image_path, position)
SELECT id, image_path, 0 FROM listings
WHERE image_path IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM listing_photos lp WHERE lp.listing_id = listings.id);
