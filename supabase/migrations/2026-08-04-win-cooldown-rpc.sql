-- Wheel of Fortune — win cooldown + carry-over
-- Date: 2026-08-04
-- Safe to run multiple times.
--
-- Adds p_cooldown_days. A customer who won on wheel-day D cannot win on
-- D+1..D+p_cooldown_days. The intercepted prize is queued on
-- wheel_daily_state.carryover_prizes and awarded to the next qualifying
-- spinner, so a blocked win becomes someone else's win instead of vanishing.
--
-- Deposit-gate behaviour is UNCHANGED: an ineligible customer's win is still
-- destroyed and is NOT queued. Gate order matters — see GATE 1 / GATE 2 below.
--
-- Wrapped in ONE transaction so the DROP + CREATE is atomic: other sessions
-- block on the function lock and then see the NEW function, never a window
-- where claim_spin is missing (which would be a wheel outage on this shared
-- prod DB). Apply as ONE statement batch, NOT split per-statement.
--
-- Requires 2026-08-04-win-cooldown-columns.sql to have been applied first.
BEGIN;

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
  p_cooldown_days integer DEFAULT 3
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
BEGIN
  v_seqname := format('wheel_seq_%s_%s', to_char(p_day, 'YYYYMMDD'), substr(md5(p_bucket), 1, 8));

  IF NOT EXISTS (
    SELECT 1 FROM wheel_daily_state WHERE day_date = p_day AND test_bucket = p_bucket
  ) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('wheelinit|' || p_day::text || '|' || p_bucket, 0));
    INSERT INTO wheel_daily_state (
      day_date, test_bucket, algorithm_id, winning_positions,
      total_spins, total_wins, total_budget_spent
    ) VALUES (
      p_day, p_bucket, p_algorithm_id, p_winning_positions, 0, 0, 0
    )
    ON CONFLICT (day_date, test_bucket) DO NOTHING;
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS public.%I', v_seqname);
  END IF;

  -- Dedup on the CUSTOMER only, so different accounts can share one device.
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
  ELSE
    v_prize := NULLIF(v_map ->> v_spin_number::text, '')::int;
    v_is_win := v_prize IS NOT NULL;
  END IF;

  -- GATE 1 — deposit eligibility. UNCHANGED: an ineligible customer's win is
  -- destroyed outright and is deliberately NOT queued for carry-over. This gate
  -- runs FIRST so that a spinner who is both ineligible AND in cooldown has
  -- their prize burned, exactly as today — reversing the order would quietly
  -- increase payout.
  IF v_is_win AND NOT p_eligible THEN
    v_is_win := false;
    v_prize := NULL;
    v_forced_ineligible := true;
  END IF;

  -- GATE 2 — win cooldown. Only reached by an otherwise fully-qualified winner,
  -- and only evaluated when this spin already landed on a winning position
  -- (~1% of spins), so the normal path pays nothing for this.
  IF v_is_win AND p_cooldown_days > 0 AND NOT p_skip_dedupe THEN
    SELECT EXISTS (
      SELECT 1 FROM wheel_spin_log
      WHERE customer_id = p_customer
        AND test_bucket = p_bucket
        AND won
        AND day_date >= p_day - p_cooldown_days
        AND day_date < p_day
    ) INTO v_in_cooldown;

    IF v_in_cooldown THEN
      -- Bank the prize for the next qualifying spinner instead of burning it.
      UPDATE wheel_daily_state
      SET carryover_prizes = carryover_prizes || to_jsonb(v_prize)
      WHERE day_date = p_day AND test_bucket = p_bucket;
      v_is_win := false;
      v_prize := NULL;
      v_cooldown_blocked := true;
    END IF;
  END IF;

  -- CARRY-OVER AWARD — a losing spin by a fully-qualified player collects a
  -- prize the cooldown intercepted earlier today. v_carry was read above and is
  -- empty virtually always, so the cooldown lookup below almost never runs.
  -- NOT v_cooldown_blocked keeps a just-blocked spinner from collecting the
  -- prize they themselves just banked.
  IF NOT v_is_win
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
      -- Serialize poppers on this day's queue. Only reached when the queue is
      -- non-empty, so this lock is virtually never contended.
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
      WHEN 10 THEN 0 WHEN 50 THEN 2 WHEN 200 THEN 4 WHEN 20 THEN 6 WHEN 100 THEN 8
      ELSE NULL END;
    IF v_segment IS NULL THEN
      RAISE EXCEPTION 'Unknown prize amount: %', v_prize;
    END IF;

    UPDATE wheel_daily_state
    SET total_wins = total_wins + 1,
        total_budget_spent = total_budget_spent + v_prize
    WHERE day_date = p_day AND test_bucket = p_bucket
    RETURNING total_wins, total_budget_spent INTO v_wins, v_budget;
  ELSE
    v_segment := (ARRAY[1, 3, 5, 7, 9])[1 + (floor(random() * 5))::int];
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

GRANT EXECUTE ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer) TO service_role;

COMMIT;
