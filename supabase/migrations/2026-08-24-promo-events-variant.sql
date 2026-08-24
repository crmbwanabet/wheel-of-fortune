-- Which promo site produced the event, independent of the serving domain.
-- The interim path links (/spin, /bonus) share one vercel.app host, so host
-- alone can no longer tell the two sites apart. NULL on rows from before
-- this column existed.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE public.promo_events
  ADD COLUMN IF NOT EXISTS variant text CHECK (variant IN ('new', 'existing'));
CREATE INDEX IF NOT EXISTS promo_events_variant_time_idx
  ON public.promo_events (variant, created_at DESC);

COMMIT;
