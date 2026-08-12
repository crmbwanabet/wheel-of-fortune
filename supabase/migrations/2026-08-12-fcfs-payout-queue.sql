-- Wheel of Fortune — FCFS payout queue + 7-day deposit window
-- Date: 2026-08-12   Spec: docs/superpowers/specs/2026-08-12-fcfs-payout-queue-design.md
-- Safe to run multiple times.
--
-- Wrapped in a single transaction so the DROP + CREATE of claim_spin is atomic:
-- other sessions block on the function lock and then see the NEW function — they
-- never observe a window where claim_spin is missing (which would be a wheel
-- outage on this shared prod DB). Apply as one statement batch (e.g. execute_sql),
-- NOT split per-statement.
--
-- PROD-SAFETY: p_payout_mode defaults to 'positions', which reproduces the
-- current behaviour exactly. Prod (main) keeps calling with the old argument
-- list and is unaffected until the route passes p_payout_mode='queue'.
BEGIN;

-- 1. Queue storage on the daily-state row.
ALTER TABLE wheel_daily_state
  ADD COLUMN IF NOT EXISTS prize_queue jsonb,
  ADD COLUMN IF NOT EXISTS queue_pos int NOT NULL DEFAULT 0;

-- 2. Replace claim_spin. Drop the old 10-arg overload so exactly one exists.
DROP FUNCTION IF EXISTS public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean);

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
  p_payout_mode text DEFAULT 'positions',
  p_prize_queue jsonb DEFAULT NULL
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
  v_wins int;
  v_budget int;
  v_prize int;
  v_is_win boolean;
  v_segment int;
  v_forced_ineligible boolean := false;
BEGIN
  v_seqname := format('wheel_seq_%s_%s', to_char(p_day, 'YYYYMMDD'), substr(md5(p_bucket), 1, 8));

  IF NOT EXISTS (
    SELECT 1 FROM wheel_daily_state WHERE day_date = p_day AND test_bucket = p_bucket
  ) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('wheelinit|' || p_day::text || '|' || p_bucket, 0));
    INSERT INTO wheel_daily_state (
      day_date, test_bucket, algorithm_id, winning_positions, prize_queue, queue_pos,
      total_spins, total_wins, total_budget_spent
    ) VALUES (
      p_day, p_bucket, p_algorithm_id, p_winning_positions, p_prize_queue, 0, 0, 0, 0
    )
    ON CONFLICT (day_date, test_bucket) DO NOTHING;
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS public.%I', v_seqname);
  END IF;

  -- Mode-flip backfill: a day row created before queue mode existed (or before
  -- this migration) has no queue. Adopt the caller's queue on the first
  -- queue-mode spin of the day; no-op once set.
  IF p_payout_mode = 'queue' AND p_prize_queue IS NOT NULL THEN
    UPDATE wheel_daily_state SET prize_queue = p_prize_queue
    WHERE day_date = p_day AND test_bucket = p_bucket AND prize_queue IS NULL;
  END IF;

  IF NOT p_skip_dedupe THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_day::text || '|' || p_bucket || '|cust|' || p_customer, 0)
    );
    IF p_fingerprint IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended(p_day::text || '|' || p_bucket || '|fp|' || p_fingerprint, 0)
      );
    END IF;

    IF EXISTS (
      SELECT 1 FROM wheel_spin_log
      WHERE day_date = p_day
        AND test_bucket = p_bucket
        AND (customer_id = p_customer
             OR (p_fingerprint IS NOT NULL AND fingerprint = p_fingerprint))
      LIMIT 1
    ) THEN
      RETURN jsonb_build_object('error', 'already_spun');
    END IF;
  END IF;

  EXECUTE format('SELECT nextval(%L)', 'public.' || v_seqname) INTO v_spin_number;

  SELECT winning_positions INTO v_map
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
    -- empty. The UPDATE is atomic; its WHERE clause makes exhaustion
    -- race-free (0 rows updated = pot empty = loss). In SET/WHERE, queue_pos
    -- reads the OLD value; RETURNING reads the NEW one, hence queue_pos - 1.
    IF p_eligible THEN
      UPDATE wheel_daily_state
      SET queue_pos = queue_pos + 1,
          total_wins = total_wins + 1,
          total_budget_spent = total_budget_spent + (prize_queue ->> queue_pos)::int
      WHERE day_date = p_day AND test_bucket = p_bucket
        AND prize_queue IS NOT NULL
        AND queue_pos < jsonb_array_length(prize_queue)
      RETURNING (prize_queue ->> (queue_pos - 1))::int, total_wins, total_budget_spent
      INTO v_prize, v_wins, v_budget;
      v_is_win := v_prize IS NOT NULL;
    ELSE
      v_is_win := false;
      -- Telemetry: an ineligible spin while the pot still has prizes is a
      -- blocked would-be win (feeds wheel_deposit_checks.enforced).
      SELECT (prize_queue IS NOT NULL AND queue_pos < jsonb_array_length(prize_queue))
      INTO v_forced_ineligible
      FROM wheel_daily_state
      WHERE day_date = p_day AND test_bucket = p_bucket;
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

  IF v_is_win THEN
    v_segment := CASE v_prize
      WHEN 10 THEN 0 WHEN 50 THEN 2 WHEN 200 THEN 4 WHEN 20 THEN 6 WHEN 100 THEN 8
      ELSE NULL END;
    IF v_segment IS NULL THEN
      RAISE EXCEPTION 'Unknown prize amount: %', v_prize;
    END IF;

    -- The queue pop already updated the counters (v_wins set by RETURNING);
    -- positions-mode and forced wins update them here.
    IF v_wins IS NULL THEN
      UPDATE wheel_daily_state
      SET total_wins = total_wins + 1,
          total_budget_spent = total_budget_spent + v_prize
      WHERE day_date = p_day AND test_bucket = p_bucket
      RETURNING total_wins, total_budget_spent INTO v_wins, v_budget;
    END IF;
  ELSE
    v_segment := (ARRAY[1, 3, 5, 7, 9])[1 + (floor(random() * 5))::int];
  END IF;

  INSERT INTO wheel_spin_log (
    day_date, test_bucket, customer_id, spin_number,
    won, prize_amount, segment_index, fingerprint, ip_address
  ) VALUES (
    p_day, p_bucket, p_customer, v_spin_number,
    v_is_win, COALESCE(v_prize, 0), v_segment, p_fingerprint, p_ip
  );

  RETURN jsonb_build_object(
    'win', v_is_win,
    'segment_index', v_segment,
    'prize_amount', v_prize,
    'spin_number', v_spin_number,
    'wins_today', v_wins,
    'budget_today', v_budget,
    'forced_loss_ineligible', v_forced_ineligible
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, text, jsonb) TO service_role;

COMMIT;
