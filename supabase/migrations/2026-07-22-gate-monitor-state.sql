-- Wheel of Fortune — gate-monitor alert state
-- Date: 2026-07-22. Safe to run multiple times.

CREATE TABLE IF NOT EXISTS wheel_monitor_state (
  condition     text PRIMARY KEY,            -- api_failing | latency | false_denials
  firing        boolean     NOT NULL DEFAULT false,
  last_alert_at timestamptz,
  last_value    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE wheel_monitor_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wheel_monitor_state FROM anon, authenticated;
GRANT ALL ON wheel_monitor_state TO service_role;
