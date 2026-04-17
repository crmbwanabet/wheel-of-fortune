-- Supabase-backed rate limiter
-- Replaces per-serverless-instance in-memory Map which didn't survive
-- Vercel's multi-instance request routing.
-- Safe to run multiple times.

-- ----------------------------------------------------------------------------
-- 1. Bucket table — one row per (scope, ip, window) with a running count
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rate_limit_bucket (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  count int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS rate_limit_bucket_window_idx
  ON rate_limit_bucket (window_start);

-- ----------------------------------------------------------------------------
-- 2. RPC — atomically increment counter for (scope, ip, current-window)
--          and return whether under limit. Uses fixed time windows.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION check_rate_limit(
  p_scope text,
  p_ip text,
  p_limit int,
  p_window_sec int
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_window bigint;
  v_key text;
  v_count int;
BEGIN
  -- Fixed-window key: same key for all requests in the same N-second bucket
  v_window := floor(extract(epoch from now()) / p_window_sec)::bigint;
  v_key := p_scope || ':' || p_ip || ':' || v_window::text;

  INSERT INTO rate_limit_bucket (bucket_key, window_start, count)
  VALUES (v_key, now(), 1)
  ON CONFLICT (bucket_key) DO UPDATE
    SET count = rate_limit_bucket.count + 1
  RETURNING count INTO v_count;

  -- Opportunistic cleanup: 1% chance per call, deletes buckets older than 10 min.
  IF random() < 0.01 THEN
    DELETE FROM rate_limit_bucket WHERE window_start < now() - interval '10 minutes';
  END IF;

  RETURN v_count <= p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION check_rate_limit(text, text, int, int) TO service_role;
