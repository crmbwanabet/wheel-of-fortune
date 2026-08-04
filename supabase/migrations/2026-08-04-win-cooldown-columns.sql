-- Wheel of Fortune — win-cooldown schema
-- Date: 2026-08-04
-- Safe to run multiple times.
--
-- NOT transaction-wrapped, on purpose: CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block. Apply these statements ONE AT A TIME. This is the
-- shared CRM/wheel production database; a plain CREATE INDEX would hold a write
-- lock on wheel_spin_log for the duration of the build.
--
-- ADD COLUMN ... NOT NULL DEFAULT <constant> is metadata-only on PG 11+, so
-- these are instant even on the ~100k-row spin log.

-- Prizes intercepted by the win cooldown, queued for the next qualifying
-- spinner. FIFO: index 0 is the head. Empty virtually all of the time.
ALTER TABLE wheel_daily_state
  ADD COLUMN IF NOT EXISTS carryover_prizes jsonb NOT NULL DEFAULT '[]'::jsonb;

-- A cooldown-blocked win is written to the log as an ordinary loss, so without
-- this flag it is indistinguishable from one and the rule is unverifiable.
ALTER TABLE wheel_spin_log
  ADD COLUMN IF NOT EXISTS cooldown_blocked boolean NOT NULL DEFAULT false;

-- Confirms an intercepted prize actually reached another player.
ALTER TABLE wheel_spin_log
  ADD COLUMN IF NOT EXISTS carryover_awarded boolean NOT NULL DEFAULT false;

-- Backs the cooldown lookup. Partial on `won`, so it indexes only winners
-- (~180 rows per 12 days) rather than the whole spin log.
CREATE INDEX CONCURRENTLY IF NOT EXISTS wheel_spin_log_winner_idx
  ON wheel_spin_log (customer_id, day_date)
  WHERE won;
