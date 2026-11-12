-- 0016_remove_alert_test_subscriber.sql (Postgres)
-- One-time cleanup: remove the fake alert-test@example.com subscriber row
-- created during the November 11, 2026 alerts testing (undeliverable
-- address; SendGrid drops it). Keeps the owner-facing subscriber count
-- honest. Idempotent: DELETE ... WHERE matches zero rows on re-run.
DELETE FROM alert_subscribers WHERE email = 'alert-test@example.com';
