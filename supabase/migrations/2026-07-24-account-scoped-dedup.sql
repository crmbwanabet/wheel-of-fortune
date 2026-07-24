-- Wheel of Fortune — account-scoped dedup (shared-device support)
-- Date: 2026-07-24
-- Safe to run multiple times.
--
-- Replaces claim_spin so dedup keys on customer_id ONLY (not the device
-- fingerprint), letting multiple accounts spin from one shared computer.
-- Fingerprint is still LOGGED for fraud analytics. Anti-farming moves to the
-- deposit-eligibility gate (DEPOSIT_GATE_MODE=enforce). Same-account double-spin
-- is still blocked by the customer_id match + the per-customer advisory lock.
--
-- Wrapped in one transaction so the DROP + CREATE is atomic (no window where
-- claim_spin is missing on the shared prod DB). Apply as ONE statement batch.
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
  p_eligible boolean DEFAULT true
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
      day_date, test_bucket, algorithm_id, winning_positions,
      total_spins, total_wins, total_budget_spent
    ) VALUES (
      p_day, p_bucket, p_algorithm_id, p_winning_positions, 0, 0, 0
    )
    ON CONFLICT (day_date, test_bucket) DO NOTHING;
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS public.%I', v_seqname);
  END IF;

  -- Dedup on the CUSTOMER only. The fingerprint lock + fingerprint OR-clause
  -- were removed so different accounts on the same device are not blocked.
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

  SELECT winning_positions INTO v_map
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

  -- Deposit gate: an ineligible customer cannot win — convert a would-be win
  -- into a loss BEFORE segment mapping and counter updates.
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

GRANT EXECUTE ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean) TO service_role;

COMMIT;
