-- 0014_alert_subscribers.sql (Postgres)
-- Email alerts when a new car is listed. One row per email address; the
-- token powers the per-recipient unsubscribe link in each alert.
CREATE TABLE IF NOT EXISTS alert_subscribers (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  token TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unsubscribed_at TIMESTAMPTZ
);
