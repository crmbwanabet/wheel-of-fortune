-- Wheel of Fortune — record WHICH page an error report came from
-- Date: 2026-08-10
-- Safe to run multiple times.
--
-- embed.js has always sent `context: location.host`, and /api/telemetry has
-- always accepted it, but reportError dropped the field on the floor: it was
-- passed as `extra` and read by nothing, reaching neither the Telegram alert
-- nor this table.
--
-- The cost was concrete. Three `widget_never_ready` reports on 2026-08-06/07
-- read as customer failures; commit timestamps and the code state at the time
-- showed they came from a developer's own browser testing the diagnosis path
-- against the production origin. One column would have said so immediately.
--
-- Additive and nullable: existing rows keep NULL, and the column is written
-- only when the reporter supplied a host. Table-level grants already cover it.

ALTER TABLE wheel_error_log ADD COLUMN IF NOT EXISTS host text;
