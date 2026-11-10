-- 0004_owner_contact_and_message_delivery.sql (Postgres)
CREATE TABLE IF NOT EXISTS owner_settings (
  id SERIAL PRIMARY KEY,
  owner_name TEXT NOT NULL,
  owner_phone TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DO $$ BEGIN ALTER TABLE messages ADD COLUMN delivery_channel TEXT NOT NULL DEFAULT 'in_app'; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE messages ADD COLUMN sent_at TIMESTAMPTZ; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
