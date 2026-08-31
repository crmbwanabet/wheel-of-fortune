-- Outbox for Telegram win notifications. Wallets are credited MANUALLY from
-- the Telegram group, so a lost message is an unpaid player. Every real win
-- is written here BEFORE the first send attempt; /api/notify-sweep re-sends
-- anything unconfirmed every few minutes until Telegram accepts it. The
-- hourly pacing releases wins in bursts that blow through Telegram's
-- ~1 msg/sec group limit, so first-attempt failures are normal, not rare.
-- Security posture mirrors the wheel tables: RLS on, service_role only.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.wheel_win_notifications (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  day_date        date        NOT NULL,
  customer_id     text        NOT NULL,
  prize_kwacha    integer     NOT NULL,
  message         text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts        integer     NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  sent_at         timestamptz,
  -- A customer wins at most once per wheel-day, so this makes enqueue
  -- idempotent across retried spin requests.
  UNIQUE (day_date, customer_id)
);
CREATE INDEX IF NOT EXISTS wheel_win_notifications_pending_idx
  ON public.wheel_win_notifications (created_at)
  WHERE status = 'pending';

ALTER TABLE public.wheel_win_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wheel_win_notifications FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wheel_win_notifications TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.wheel_win_notifications_id_seq TO service_role;

COMMIT;
