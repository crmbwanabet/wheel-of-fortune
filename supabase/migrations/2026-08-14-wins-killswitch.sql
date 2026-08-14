-- Wheel of Fortune — operator killswitch for payouts
-- Date: 2026-08-14
-- Safe to run multiple times.
--
-- WHY
-- On 2026-08-14 the payout mode was switched mid-day. The day had already paid
-- K460 under the old algorithm, and the FCFS queue is a fresh K2,000 pot, so the
-- two stacked: K1,710 went out in ten minutes before it was stopped, finishing
-- K170 over the K2,000 daily budget.
--
-- Stopping it took hand-written SQL against wheel_daily_state — drain queue_pos,
-- blank winning_positions, empty carryover_prizes. That worked, but it is
-- destructive (the day's prize map is gone and cannot be restored) and there is
-- no clean way back. This table is the same capability done properly:
-- reversible, leaves no wreckage, effective on the very next spin.
--
-- WHAT IT IS NOT
-- Not SPIN_MAINTENANCE, which takes the whole wheel offline. Here the wheel keeps
-- spinning and every customer lands on "Try Again Tomorrow" — claim_spin already
-- picks a random loss segment from ARRAY[1,3,5,7,9], all of which carry that
-- label. No new UI path, so nothing new can break in front of a customer.
--
-- HOW IT WORKS
-- claim_spin is NOT modified. Passing p_eligible = false already suppresses every
-- payout route, and each of those branches is code that has been live for weeks:
--   - queue mode      IF NOT p_eligible THEN v_is_win := false   (no queue pop,
--                     so the pot is preserved, not consumed)
--   - positions mode  IF v_is_win AND NOT p_eligible THEN v_is_win := false
--   - carryover       the whole block is gated on p_eligible
-- Only p_force_prize (test-token gated) can still pay, which is what lets the
-- verify script exercise win paths while proving the switch works.
--
-- The route reads this row per spin and passes p_eligible = false when engaged.
-- One extra single-row primary-key lookup per spin: at ~6,000 spins/day that is
-- negligible even on the CRM-shared instance (see the 2026-07-13 incident).
-- The read FAILS OPEN — see lib/killSwitch.js for why a self-engaging killswitch
-- is the more expensive failure.

CREATE TABLE IF NOT EXISTS wheel_controls (
  -- Single row, enforced. A killswitch with two rows is a killswitch nobody
  -- can reason about under pressure.
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  wins_disabled boolean NOT NULL DEFAULT false,
  -- Why it was flipped, so the next person to look knows whether to unflip it.
  reason        text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Seed the row so the read is a plain lookup and never has to handle "no row"
-- as a special case in normal operation.
INSERT INTO wheel_controls (id, wins_disabled, reason)
VALUES (1, false, 'initial — payouts enabled')
ON CONFLICT (id) DO NOTHING;

-- Same lockdown as every other wheel table: RLS on, no policies, service_role
-- only. The anon key is shared with the CRM project (see the 2026-07 audit), so
-- a readable killswitch would be a writable one.
ALTER TABLE wheel_controls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wheel_controls FROM anon, authenticated;
GRANT ALL ON wheel_controls TO service_role;

-- ---------------------------------------------------------------------------
-- OPERATOR USE
--
--   STOP ALL WINS (takes effect on the next spin):
--     UPDATE wheel_controls
--     SET wins_disabled = true, reason = 'over budget', updated_at = now()
--     WHERE id = 1;
--
--   RESUME WINS:
--     UPDATE wheel_controls
--     SET wins_disabled = false, reason = 'resumed', updated_at = now()
--     WHERE id = 1;
--
--   CHECK CURRENT STATE:
--     SELECT wins_disabled, reason, updated_at FROM wheel_controls WHERE id = 1;
--
-- Engaging it costs the customer their daily spin — they played and lost, which
-- is the normal loss contract. It does NOT consume queue prizes or carryover, so
-- the pot survives and is still there when payouts resume.
-- ---------------------------------------------------------------------------
