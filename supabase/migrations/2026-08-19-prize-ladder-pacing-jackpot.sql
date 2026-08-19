-- Wheel of Fortune — 250-win K5..K200 ladder, hourly payout pacing, 14 segments
-- Date: 2026-08-19   Spec: docs/superpowers/specs/2026-08-19-prize-ladder-pacing-jackpot-design.md
-- Safe to run multiple times.
--
-- BASELINE: the LIVE prod claim_spin (11-arg, with winner cooldown + prize
-- carryover — see docs/db/2026-08-12-prod-claim-spin-baseline.sql), NOT the
-- repo's 2026-07-24 migration, which prod had drifted past. All live behaviour
-- (customer-only dedupe, cooldown, carryover) is preserved in positions mode.
--
-- Wrapped in a single transaction: concurrent sessions keep seeing the old
-- function until COMMIT (MVCC), then atomically see the new one — there is no
-- window where claim_spin is missing. Apply as ONE statement batch (e.g.
-- execute_sql), NOT split per-statement.
--
-- PROD-SAFETY: p_payout_mode defaults to 'positions', which reproduces the
-- live behaviour exactly. Prod (main) keeps calling with the old argument
-- list and is unaffected until the route passes p_payout_mode='queue'.
BEGIN;

-- Fail fast (retryable) instead of stalling the live wheel if the ALTER's
-- ACCESS EXCLUSIVE lock queues behind slow in-flight spins.
SET LOCAL lock_timeout = '3s';

-- 1. Queue storage on the daily-state row (metadata-only column adds).
ALTER TABLE wheel_daily_state
  ADD COLUMN IF NOT EXISTS prize_queue jsonb,
  ADD COLUMN IF NOT EXISTS queue_pos int NOT NULL DEFAULT 0;

-- 2. Replace claim_spin. Drop ALL prior signatures so exactly one remains —
-- leaving the live 11-arg version alongside a new one would make PostgREST's
-- named-arg rpc call ambiguous and 500 every spin.
DROP FUNCTION IF EXISTS public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean);          -- repo-history 10-arg (absent in prod)
DROP FUNCTION IF EXISTS public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer); -- historic 11-arg
DROP FUNCTION IF EXISTS public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer, text, jsonb); -- LIVE 13-arg (queue mode)

CREATE OR REPLACE FUNCTION public.claim_spin(
  p_day date,
  p_bucket text,
  p_customer text,
  p_fingerprint text,
  p_ip text,
  p_algorithm_id integer,
  p_winning_positions jsonb,
  p_skip_dedupe boolean DEFAULT false,
  p_force_prize integer DEFAULT NULL,
  p_eligible boolean DEFAULT true,
  p_cooldown_days integer DEFAULT 3,
  p_payout_mode text DEFAULT 'positions',
  p_prize_queue jsonb DEFAULT NULL,
  p_release_cap integer DEFAULT 2147483647
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout TO '5000ms'
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_seqname text;
  v_spin_number bigint;
  v_map jsonb;
  v_carry jsonb;
  v_wins int;
  v_budget int;
  v_prize int;
  v_is_win boolean;
  v_segment int;
  v_forced_ineligible boolean := false;
  v_cooldown_blocked boolean := false;
  v_carryover_awarded boolean := false;
  v_in_cooldown boolean := false;
  v_popped text;
  v_prev_day date;
  v_carry_in jsonb;
  v_inserted int := 0;
  v_queue_ok boolean;
BEGIN
  v_seqname := format('wheel_seq_%s_%s', to_char(p_day, 'YYYYMMDD'), substr(md5(p_bucket), 1, 8));

  -- A prize queue is adopted only if it is a jsonb ARRAY whose every element
  -- is one of the five valid prize amounts. Guards against a malformed payload
  -- jamming the day (un-castable element ⇒ every pop raises) or silently
  -- NULLing the budget counter (JSON null element).
  v_queue_ok := COALESCE(
    jsonb_typeof(p_prize_queue) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_prize_queue) e
      WHERE jsonb_typeof(e) <> 'number'
         OR NOT (e::text)::numeric IN (5, 10, 20, 50, 100, 200)
    ), false);

  IF NOT EXISTS (
    SELECT 1 FROM wheel_daily_state WHERE day_date = p_day AND test_bucket = p_bucket
  ) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('wheelinit|' || p_day::text || '|' || p_bucket, 0));

    -- Carry unclaimed carryover prizes in from the most recent prior day
    -- (within 7 days), capped at 10. (Live behaviour, positions-era feature;
    -- harmless residue on queue-mode days — the award block below is gated.)
    SELECT day_date, carryover_prizes INTO v_prev_day, v_carry_in
    FROM wheel_daily_state
    WHERE test_bucket = p_bucket
      AND day_date < p_day
      AND day_date >= p_day - 7
      AND jsonb_array_length(carryover_prizes) > 0
    ORDER BY day_date DESC
    LIMIT 1;

    IF v_carry_in IS NULL THEN
      v_carry_in := '[]'::jsonb;
    ELSIF jsonb_array_length(v_carry_in) > 10 THEN
      v_carry_in := (
        SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
        FROM (SELECT e FROM jsonb_array_elements(v_carry_in) e LIMIT 10) s
      );
    END IF;

    INSERT INTO wheel_daily_state (
      day_date, test_bucket, algorithm_id, winning_positions,
      total_spins, total_wins, total_budget_spent,
      carryover_prizes, carryover_in,
      prize_queue, queue_pos
    ) VALUES (
      p_day, p_bucket, p_algorithm_id, p_winning_positions, 0, 0, 0,
      v_carry_in, v_carry_in,
      CASE WHEN v_queue_ok THEN p_prize_queue ELSE NULL END, 0
    )
    ON CONFLICT (day_date, test_bucket) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted > 0 AND v_prev_day IS NOT NULL AND jsonb_array_length(v_carry_in) > 0 THEN
      UPDATE wheel_daily_state
      SET carryover_prizes = '[]'::jsonb
      WHERE day_date = v_prev_day AND test_bucket = p_bucket;
    END IF;

    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS public.%I', v_seqname);
  END IF;

  -- Dedup on the CUSTOMER only (live 2026-07-24 behaviour: shared devices may
  -- host several accounts; fingerprint is logged, not gating).
  IF NOT p_skip_dedupe THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_day::text || '|' || p_bucket || '|cust|' || p_customer, 0)
    );

    IF EXISTS (
      SELECT 1 FROM wheel_spin_log
      WHERE day_date = p_day
        AND test_bucket = p_bucket
        AND customer_id = p_customer
      LIMIT 1
    ) THEN
      RETURN jsonb_build_object('error', 'already_spun');
    END IF;
  END IF;

  -- Mode-flip backfill: a day row created before queue mode existed has no
  -- queue; adopt the caller's on the first queue-mode spin. No-op once set.
  -- Placed AFTER the dedupe section so the day-row lock is always taken after
  -- the advisory locks (consistent lock ordering — no deadlock window).
  IF p_payout_mode = 'queue' AND v_queue_ok THEN
    UPDATE wheel_daily_state SET prize_queue = p_prize_queue
    WHERE day_date = p_day AND test_bucket = p_bucket AND prize_queue IS NULL;
  END IF;

  EXECUTE format('SELECT nextval(%L)', 'public.' || v_seqname) INTO v_spin_number;

  SELECT winning_positions, carryover_prizes INTO v_map, v_carry
  FROM wheel_daily_state
  WHERE day_date = p_day AND test_bucket = p_bucket;

  IF v_map IS NULL THEN
    RETURN jsonb_build_object('error', 'no_state');
  END IF;

  IF p_force_prize IS NOT NULL THEN
    v_prize := p_force_prize;
    v_is_win := true;
  ELSIF p_payout_mode = 'queue' THEN
    -- FCFS queue: every eligible spin pops the next prize until the pot is
    -- empty — except recent winners (cooldown), whose prize simply stays in
    -- the queue for the next eligible spinner (no carryover write needed).
    IF NOT p_eligible THEN
      v_is_win := false;
      -- Telemetry: an ineligible spin while the pot still has prizes is a
      -- blocked would-be win (feeds wheel_deposit_checks.enforced).
      SELECT (prize_queue IS NOT NULL
              AND queue_pos < LEAST(jsonb_array_length(prize_queue), p_release_cap))
      INTO v_forced_ineligible
      FROM wheel_daily_state
      WHERE day_date = p_day AND test_bucket = p_bucket;
    ELSE
      IF p_cooldown_days > 0 AND NOT p_skip_dedupe THEN
        SELECT EXISTS (
          SELECT 1 FROM wheel_spin_log
          WHERE customer_id = p_customer
            AND test_bucket = p_bucket
            AND won
            AND day_date >= p_day - p_cooldown_days
            AND day_date < p_day
        ) INTO v_in_cooldown;
      END IF;

      IF v_in_cooldown THEN
        v_is_win := false;
        v_cooldown_blocked := true;
      ELSE
        -- Atomic pop. SET/WHERE read the OLD queue_pos (the index to charge);
        -- RETURNING reads the NEW value, hence queue_pos - 1 for the same
        -- element. 0 rows updated = pot empty = loss, race-free.
        UPDATE wheel_daily_state
        SET queue_pos = queue_pos + 1,
            total_wins = total_wins + 1,
            total_budget_spent = total_budget_spent + (prize_queue ->> queue_pos)::int
        WHERE day_date = p_day AND test_bucket = p_bucket
          AND prize_queue IS NOT NULL
          AND queue_pos < LEAST(jsonb_array_length(prize_queue), p_release_cap)
        RETURNING (prize_queue ->> (queue_pos - 1))::int, total_wins, total_budget_spent
        INTO v_prize, v_wins, v_budget;
        v_is_win := v_prize IS NOT NULL;
      END IF;
    END IF;
  ELSE
    v_prize := NULLIF(v_map ->> v_spin_number::text, '')::int;
    v_is_win := v_prize IS NOT NULL;
  END IF;

  -- Deposit gate for the positions/forced paths (the queue path is gated
  -- before the pop, so this never fires for it: ineligible ⇒ v_is_win=false).
  IF v_is_win AND NOT p_eligible THEN
    v_is_win := false;
    v_prize := NULL;
    v_forced_ineligible := true;
  END IF;

  -- Winner cooldown, positions/forced paths only (queue handled the cooldown
  -- before its pop): a recent winner's would-be win becomes a loss and the
  -- prize carries over. NOTE: in queue mode a p_force_prize win intentionally
  -- bypasses the cooldown — forced prizes are test-token-gated and "forced
  -- means forced"; positions mode keeps the live baseline behaviour.
  IF p_payout_mode <> 'queue' AND v_is_win AND p_cooldown_days > 0 AND NOT p_skip_dedupe THEN
    SELECT EXISTS (
      SELECT 1 FROM wheel_spin_log
      WHERE customer_id = p_customer
        AND test_bucket = p_bucket
        AND won
        AND day_date >= p_day - p_cooldown_days
        AND day_date < p_day
    ) INTO v_in_cooldown;

    IF v_in_cooldown THEN
      IF v_prize IN (5, 10, 20, 50, 100, 200) THEN
        UPDATE wheel_daily_state
        SET carryover_prizes = carryover_prizes || to_jsonb(v_prize)
        WHERE day_date = p_day AND test_bucket = p_bucket;
      END IF;
      v_is_win := false;
      v_prize := NULL;
      v_cooldown_blocked := true;
    END IF;
  END IF;

  -- Carryover award, positions mode only: an eligible, losing, non-cooldown
  -- spinner claims a carried-over prize. Gated off in queue mode to keep the
  -- day's payout exactly the K2,000 queue (no extra budget beyond the pot).
  IF p_payout_mode <> 'queue'
     AND NOT v_is_win
     AND p_eligible
     AND NOT p_skip_dedupe
     AND NOT v_cooldown_blocked
     AND v_carry IS NOT NULL
     AND jsonb_array_length(v_carry) > 0
  THEN
    IF p_cooldown_days > 0 THEN
      SELECT EXISTS (
        SELECT 1 FROM wheel_spin_log
        WHERE customer_id = p_customer
          AND test_bucket = p_bucket
          AND won
          AND day_date >= p_day - p_cooldown_days
          AND day_date < p_day
      ) INTO v_in_cooldown;
    ELSE
      v_in_cooldown := false;
    END IF;

    IF NOT v_in_cooldown THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended('wheelcarry|' || p_day::text || '|' || p_bucket, 0)
      );

      SELECT carryover_prizes ->> 0 INTO v_popped
      FROM wheel_daily_state
      WHERE day_date = p_day
        AND test_bucket = p_bucket
        AND jsonb_array_length(carryover_prizes) > 0;

      IF v_popped IS NOT NULL THEN
        UPDATE wheel_daily_state
        SET carryover_prizes = carryover_prizes - 0
        WHERE day_date = p_day AND test_bucket = p_bucket;
        v_prize := v_popped::int;
        v_is_win := true;
        v_carryover_awarded := true;
      END IF;
    END IF;
  END IF;

  IF v_is_win THEN
    v_segment := CASE v_prize
      WHEN 5 THEN 0 WHEN 10 THEN 2 WHEN 20 THEN 4
      WHEN 50 THEN 6 WHEN 100 THEN 8 WHEN 200 THEN 10
      ELSE NULL END;
    IF v_segment IS NULL THEN
      RAISE EXCEPTION 'Unknown prize amount: %', v_prize;
    END IF;

    -- The queue pop already updated the counters (v_wins set by RETURNING);
    -- positions-mode, carryover, and forced wins update them here.
    IF v_wins IS NULL THEN
      UPDATE wheel_daily_state
      SET total_wins = total_wins + 1,
          total_budget_spent = total_budget_spent + v_prize
      WHERE day_date = p_day AND test_bucket = p_bucket
      RETURNING total_wins, total_budget_spent INTO v_wins, v_budget;
    END IF;
  ELSE
    v_segment := (ARRAY[1, 3, 5, 7, 9, 11, 13])[1 + (floor(random() * 7))::int];
  END IF;

  INSERT INTO wheel_spin_log (
    day_date, test_bucket, customer_id, spin_number,
    won, prize_amount, segment_index, fingerprint, ip_address,
    cooldown_blocked, carryover_awarded
  ) VALUES (
    p_day, p_bucket, p_customer, v_spin_number,
    v_is_win, COALESCE(v_prize, 0), v_segment, p_fingerprint, p_ip,
    v_cooldown_blocked, v_carryover_awarded
  );

  RETURN jsonb_build_object(
    'win', v_is_win,
    'segment_index', v_segment,
    'prize_amount', v_prize,
    'spin_number', v_spin_number,
    'wins_today', v_wins,
    'budget_today', v_budget,
    'forced_loss_ineligible', v_forced_ineligible,
    'forced_loss_cooldown', v_cooldown_blocked,
    'carryover_awarded', v_carryover_awarded
  );
END;
$function$;

-- 3. Harden: claim_spin is SECURITY DEFINER with p_skip_dedupe/p_force_prize —
-- it must NOT be callable with the browser-exposed anon key. Only the server
-- route (service_role) may execute it. (Closes a pre-existing gap: Supabase's
-- default privileges had granted EXECUTE to anon/authenticated/PUBLIC.)
REVOKE ALL ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer, text, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer, text, jsonb, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer, text, jsonb, integer) TO service_role;

COMMIT;
