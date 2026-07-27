-- Wheel of Fortune — persistent error log
-- Date: 2026-07-27
-- Safe to run multiple times.
--
-- The telemetry alerter (lib/telemetry.js) was in-memory only, so errors sent to
-- the owner's Telegram DM left no auditable record. This table persists ONE row
-- per dispatched alert (bounded by the alerter's existing 6/min rate cap, so it
-- cannot amplify DB load during an error storm). Same lockdown pattern as the
-- other wheel tables: RLS on, no policies, service_role only.

CREATE TABLE IF NOT EXISTS wheel_error_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  signature    text,                       -- route:code|status (dedup key)
  route        text,
  code         text,
  status       int,
  customer_id  text,
  message      text,
  occurrences  int NOT NULL DEFAULT 1,      -- >1 for rollup alerts (repeats collapsed in-window)
  source       text
);

CREATE INDEX IF NOT EXISTS wheel_error_log_created_idx ON wheel_error_log (created_at DESC);
CREATE INDEX IF NOT EXISTS wheel_error_log_sig_idx     ON wheel_error_log (signature);

ALTER TABLE wheel_error_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wheel_error_log FROM anon, authenticated;
GRANT ALL ON wheel_error_log TO service_role;
