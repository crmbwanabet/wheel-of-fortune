-- The win card now auto-redirects to BwanaBet after a countdown; that exit
-- is its own funnel event, distinct from a deliberate claim click.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE public.promo_events DROP CONSTRAINT IF EXISTS promo_events_event_check;
ALTER TABLE public.promo_events
  ADD CONSTRAINT promo_events_event_check
  CHECK (event IN ('view', 'spin', 'claim_click', 'auto_redirect'));

COMMIT;
