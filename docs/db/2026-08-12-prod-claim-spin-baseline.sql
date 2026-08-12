-- ============================================================================
-- SNAPSHOT — DO NOT APPLY. Documentation only.
--
-- The LIVE public.claim_spin as captured from prod (blrrcnrhixckfudiojwe) via
-- pg_get_functiondef on 2026-08-12, during work on the FCFS payout queue.
--
-- WHY THIS FILE EXISTS: the migrations directory had drifted from prod. The
-- repo's latest claim_spin migration (2026-07-24-account-scoped-dedup.sql) is
-- a 10-arg function, but prod runs this 11-arg version with a WINNER COOLDOWN
-- and PRIZE CARRYOVER system that was applied directly to prod (deliberately,
-- per stakeholder 2026-08-12) and never committed:
--
--   * p_cooldown_days (default 3): a customer who WON in the last N wheel-days
--     has any new would-be win converted to a loss (forced_loss_cooldown).
--   * The blocked prize is appended to wheel_daily_state.carryover_prizes.
--   * Day-init pulls up to 10 carryover prizes from the most recent prior day
--     (within 7 days) into the new day (carryover_prizes + carryover_in audit
--     column), clearing the source day.
--   * An eligible, losing, non-cooldown spinner can pop a carryover prize and
--     win it (carryover_awarded), under a 'wheelcarry' advisory lock.
--   * wheel_spin_log gained cooldown_blocked / carryover_awarded columns; the
--     return JSON gained forced_loss_cooldown / carryover_awarded.
--
-- The 2026-08-12 FCFS migration treats THIS definition as its baseline and
-- preserves all of the above in positions mode.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claim_spin(p_day date, p_bucket text, p_customer text, p_fingerprint text, p_ip text, p_algorithm_id integer, p_winning_positions jsonb, p_skip_dedupe boolean DEFAULT false, p_force_prize integer DEFAULT NULL::integer, p_eligible boolean DEFAULT true, p_cooldown_days integer DEFAULT 3)
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
BEGIN
  v_seqname := format('wheel_seq_%s_%s', to_char(p_day, 'YYYYMMDD'), substr(md5(p_bucket), 1, 8));

  IF NOT EXISTS (
    SELECT 1 FROM wheel_daily_state WHERE day_date = p_day AND test_bucket = p_bucket
  ) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('wheelinit|' || p_day::text || '|' || p_bucket, 0));

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

    IF v_inserted > 0 AND v_prev_day IS NOT NULL AND jsonb_array_length(v_carry_in) > 0 THEN
      UPDATE wheel_daily_state
      SET carryover_prizes = '[]'::jsonb
      WHERE day_date = v_prev_day AND test_bucket = p_bucket;
    END IF;

    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS public.%I', v_seqname);
  END IF;

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

  IF v_is_win AND NOT p_eligible THEN
    v_is_win := false;
    v_prize := NULL;
    v_forced_ineligible := true;
  END IF;

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
$function$
