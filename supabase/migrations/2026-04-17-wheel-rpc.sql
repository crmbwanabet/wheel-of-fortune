-- Wheel of Fortune — Atomic RPC rewrite
-- Date: 2026-04-17
-- Safe to run multiple times.

-- ----------------------------------------------------------------------------
-- 1. Add test_bucket column to both tables (non-breaking; defaults to '')
-- ----------------------------------------------------------------------------

ALTER TABLE wheel_daily_state
  ADD COLUMN IF NOT EXISTS test_bucket text NOT NULL DEFAULT '';

ALTER TABLE wheel_spin_log
  ADD COLUMN IF NOT EXISTS test_bucket text NOT NULL DEFAULT '';

-- ----------------------------------------------------------------------------
-- 2. Replace unique(day_date) with unique(day_date, test_bucket)
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  v_con_name text;
BEGIN
  SELECT conname INTO v_con_name
  FROM pg_constraint
  WHERE conrelid = 'wheel_daily_state'::regclass
    AND contype = 'u'
    AND conkey = (
      SELECT array_agg(attnum ORDER BY attnum)
      FROM pg_attribute
      WHERE attrelid = 'wheel_daily_state'::regclass
        AND attname = 'day_date'
    )
  LIMIT 1;

  IF v_con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE wheel_daily_state DROP CONSTRAINT %I', v_con_name);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wheel_daily_state'::regclass
      AND conname = 'wheel_daily_state_day_bucket_key'
  ) THEN
    ALTER TABLE wheel_daily_state
      ADD CONSTRAINT wheel_daily_state_day_bucket_key UNIQUE (day_date, test_bucket);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. Dedupe indexes on wheel_spin_log (back the claim_spin dedupe query)
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS wheel_spin_log_dedupe_customer_idx
  ON wheel_spin_log (day_date, test_bucket, customer_id);

CREATE INDEX IF NOT EXISTS wheel_spin_log_dedupe_fingerprint_idx
  ON wheel_spin_log (day_date, test_bucket, fingerprint)
  WHERE fingerprint IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 4. ensure_daily_state — idempotent init of one (day, bucket) state row
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ensure_daily_state(
  p_day date,
  p_bucket text,
  p_algorithm_id int,
  p_winning_positions jsonb
) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO wheel_daily_state (
    day_date, test_bucket, algorithm_id, winning_positions,
    total_spins, total_wins, total_budget_spent
  ) VALUES (
    p_day, p_bucket, p_algorithm_id, p_winning_positions, 0, 0, 0
  )
  ON CONFLICT (day_date, test_bucket) DO NOTHING;
$$;

-- ----------------------------------------------------------------------------
-- 5. claim_spin — atomic dedupe + counter + win lookup + log, one transaction
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION claim_spin(
  p_day date,
  p_bucket text,
  p_customer text,
  p_fingerprint text,
  p_ip text,
  p_skip_dedupe boolean DEFAULT false,
  p_force_prize int DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_spin_number int;
  v_map jsonb;
  v_wins int;
  v_budget int;
  v_prize int;
  v_is_win boolean;
  v_segment int;
BEGIN
  -- Dedupe (skipped in test mode). Per-customer advisory lock makes the
  -- SELECT EXISTS check race-safe: concurrent spins with the same customer
  -- serialize behind the lock, so only one gets past the check. Different
  -- customers don't contend. Lock is released automatically at txn end.
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

  -- Atomic increment via row lock
  UPDATE wheel_daily_state
  SET total_spins = total_spins + 1
  WHERE day_date = p_day AND test_bucket = p_bucket
  RETURNING total_spins, winning_positions, total_wins, total_budget_spent
  INTO v_spin_number, v_map, v_wins, v_budget;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'no_state');
  END IF;

  -- Win lookup: force-prize (test) or map lookup
  IF p_force_prize IS NOT NULL THEN
    v_prize := p_force_prize;
    v_is_win := true;
  ELSE
    v_prize := NULLIF(v_map ->> v_spin_number::text, '')::int;
    v_is_win := v_prize IS NOT NULL;
  END IF;

  -- Segment mapping
  IF v_is_win THEN
    v_segment := CASE v_prize
      WHEN 10 THEN 0
      WHEN 50 THEN 2
      WHEN 200 THEN 4
      WHEN 20 THEN 6
      WHEN 100 THEN 8
      ELSE NULL
    END;
    IF v_segment IS NULL THEN
      RAISE EXCEPTION 'Unknown prize amount: %', v_prize;
    END IF;
  ELSE
    v_segment := (ARRAY[1, 3, 5, 7, 9])[1 + (floor(random() * 5))::int];
  END IF;

  -- Update counters on win (same txn)
  IF v_is_win THEN
    UPDATE wheel_daily_state
    SET total_wins = total_wins + 1,
        total_budget_spent = total_budget_spent + v_prize
    WHERE day_date = p_day AND test_bucket = p_bucket;

    v_wins := v_wins + 1;
    v_budget := v_budget + v_prize;
  END IF;

  -- Log (same txn)
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
    'budget_today', v_budget
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. Grant execute on RPCs to service role (already has it, but explicit)
-- ----------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION ensure_daily_state(date, text, int, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION claim_spin(date, text, text, text, text, boolean, int) TO service_role;
