-- Wheel of Fortune — carry unclaimed prizes into the next wheel-day
-- Date: 2026-08-05
-- Safe to run multiple times.
--
-- Only the day-init block changes from 2026-08-04-win-cooldown-rpc.sql. When a
-- new wheel-day's state row is created, any prize still queued on a recent
-- earlier day is moved into it, and the source queue is cleared so nothing is
-- carried twice. Everything downstream is untouched.
--
-- Why this is needed: carryover_prizes is per (day_date, test_bucket). A prize
-- intercepted at 03:30 UTC has ~30 minutes of the thinnest traffic of the day
-- to find a qualifying loser; at 04:00 the reset created a fresh row with an
-- empty queue and the prize was orphaned. Carrying it forward means it is
-- collected within minutes of the next reset, when traffic spikes to ~50/min.
--
-- Bounded on purpose:
--   * only from the most recent prior day WITHIN 7 DAYS — a prize cannot ride
--     forward indefinitely through a long outage
--   * at most 10 entries — a queue that somehow stops draining cannot compound
--     without bound and turn into an unbounded payout
--
-- The whole block already runs under the 'wheelinit' advisory lock, so the
-- read, the insert and the clear are serialized per (day, bucket). The clear is
-- gated on FOUND: if a concurrent session won the insert race, IT performed the
-- carry and this session must not clear the source underneath it.
--
-- Requires 2026-08-05-carryover-forward-column.sql to have been applied first.
--
-- Wrapped in ONE transaction so the DROP + CREATE is atomic: other sessions
-- block on the function lock and then see the NEW function, never a window
-- where claim_spin is missing. Apply as ONE statement batch.
BEGIN;

DROP FUNCTION IF EXISTS public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer);

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
  v_prev_day date;
  v_carry_in jsonb;
  v_inserted int := 0;   -- GET DIAGNOSTICS ROW_COUNT is an integer, not a boolean
BEGIN
  v_seqname := format('wheel_seq_%s_%s', to_char(p_day, 'YYYYMMDD'), substr(md5(p_bucket), 1, 8));

  IF NOT EXISTS (
    SELECT 1 FROM wheel_daily_state WHERE day_date = p_day AND test_bucket = p_bucket
  ) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('wheelinit|' || p_day::text || '|' || p_bucket, 0));

    -- Reclaim a queue the previous wheel-day never drained.
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
      carryover_prizes, carryover_in
    ) VALUES (
      p_day, p_bucket, p_algorithm_id, p_winning_positions, 0, 0, 0,
      v_carry_in, v_carry_in
    )
    ON CONFLICT (day_date, test_bucket) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    -- Clear the source ONLY if this session actually created the new row. If a
    -- concurrent session won the race it performed the carry itself, and
    -- clearing here would drop prizes it has not yet taken ownership of.
    IF v_inserted > 0 AND v_prev_day IS NOT NULL AND jsonb_array_length(v_carry_in) > 0 THEN
      UPDATE wheel_daily_state
      SET carryover_prizes = '[]'::jsonb
      WHERE day_date = v_prev_day AND test_bucket = p_bucket;
    END IF;

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
  -- their prize burned, exactly as before — reversing the order would quietly
  -- increase payout.
  IF v_is_win AND NOT p_eligible THEN
    v_is_win := false;
    v_prize := NULL;
    v_forced_ineligible := true;
  END IF;

  -- GATE 2 — win cooldown.
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
      -- Bank the prize for the next qualifying spinner, but ONLY an amount the
      -- segment mapping below can render. A forced test prize could otherwise
      -- be banked here and raise 'Unknown prize amount' when a REAL spinner
      -- pops it later — a 500 on a customer's spin, far from its cause.
      IF v_prize IN (10, 20, 50, 100, 200) THEN
        UPDATE wheel_daily_state
        SET carryover_prizes = carryover_prizes || to_jsonb(v_prize)
        WHERE day_date = p_day AND test_bucket = p_bucket;
      END IF;
      v_is_win := false;
      v_prize := NULL;
      v_cooldown_blocked := true;
    END IF;
  END IF;

  -- CARRY-OVER AWARD — a losing spin by a fully-qualified player collects a
  -- prize the cooldown intercepted earlier, whether banked today or carried in
  -- from a previous day. NOT v_cooldown_blocked keeps a just-blocked spinner
  -- from collecting the prize they themselves just banked.
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

NOTIFY pgrst, 'reload schema';

COMMIT;
