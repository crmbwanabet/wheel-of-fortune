-- Promo wheel funnel events. One row per view / spin / claim_click.
-- Security posture mirrors the wheel tables: RLS on, no policies, service_role only.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.promo_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  host        text        NOT NULL,
  event       text        NOT NULL CHECK (event IN ('view', 'spin', 'claim_click')),
  is_mobile   boolean,
  ua          text
);
CREATE INDEX IF NOT EXISTS promo_events_host_time_idx ON public.promo_events (host, created_at DESC);

ALTER TABLE public.promo_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.promo_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.promo_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.promo_events_id_seq TO service_role;

COMMIT;
