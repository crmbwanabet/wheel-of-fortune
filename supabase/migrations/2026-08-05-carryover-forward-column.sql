-- Wheel of Fortune — carry-over forward accounting
-- Date: 2026-08-05
-- Safe to run multiple times.
--
-- carryover_prizes is scoped to one wheel-day. A prize the cooldown intercepted
-- late in the day could fail to find a collector before the 04:00 UTC reset, at
-- which point claim_spin created a fresh state row with an empty queue and the
-- prize was orphaned — never paid to anyone, never returned to the budget.
--
-- The RPC migration that accompanies this file carries an unclaimed queue
-- forward into the next wheel-day. This column records what was carried IN, so
-- the daily digest can explain why a day's payout exceeds the K2,000 budget
-- instead of the number looking like an overspend.
--
-- ADD COLUMN ... NOT NULL DEFAULT <constant> is metadata-only on PG 11+, so this
-- is instant. No index needed: it is read once per digest, by primary key.

ALTER TABLE wheel_daily_state
  ADD COLUMN IF NOT EXISTS carryover_in jsonb NOT NULL DEFAULT '[]'::jsonb;
