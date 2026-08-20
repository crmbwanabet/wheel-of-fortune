-- Error-investigation bookmark.
--
-- wheel_error_log grows continuously and nothing recorded how far a human (or
-- Claude) had actually read. Every audit therefore restarted from a guessed
-- date, which both re-litigates settled findings and risks skipping a window.
--
-- One row per completed investigation. The resume point is
-- max(reviewed_through_id); wheel_errors_unreviewed applies it so the next
-- audit is a single SELECT with no date guessing.
--
-- Security posture mirrors wheel_error_log exactly: RLS on, no policies, and
-- grants to service_role only. anon must never reach this (see the 2026-08
-- shared-project lockdown — this DB is shared with the CRM).

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.wheel_error_review (
  id                    bigserial PRIMARY KEY,
  reviewed_at           timestamptz NOT NULL DEFAULT now(),
  -- Inclusive high-water mark: every wheel_error_log row with id <= this has
  -- been looked at. Kept as the id, not a timestamp, because ids are gapless
  -- and immune to clock skew and late-arriving inserts.
  reviewed_through_id   bigint      NOT NULL,
  reviewed_through_at   timestamptz NOT NULL,
  reviewed_from_id      bigint,
  reviewer              text        NOT NULL,
  rows_reviewed         int,
  occurrences_reviewed  int,
  summary               text        NOT NULL,
  -- [{signature, occurrences, verdict, action}] — verdict is the point: it
  -- records what was CONCLUDED, so a recurring signature is not re-investigated
  -- from scratch every time.
  findings              jsonb       NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS wheel_error_review_through_idx
  ON public.wheel_error_review (reviewed_through_id DESC);

ALTER TABLE public.wheel_error_review ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.wheel_error_review FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wheel_error_review TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.wheel_error_review_id_seq TO service_role;

-- Everything not yet investigated. COALESCE(...,0) makes the very first run
-- (empty bookmark table) return the whole log rather than nothing.
CREATE OR REPLACE VIEW public.wheel_errors_unreviewed
WITH (security_invoker = true) AS
SELECT e.*
FROM public.wheel_error_log e
WHERE e.id > COALESCE((SELECT max(reviewed_through_id) FROM public.wheel_error_review), 0)
ORDER BY e.id;

REVOKE ALL ON public.wheel_errors_unreviewed FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.wheel_errors_unreviewed TO service_role;

COMMIT;
