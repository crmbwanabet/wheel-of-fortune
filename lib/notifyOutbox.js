// Rules for the win-notification outbox sweep. Pure — the route does the IO.
//
// Why this exists: wallets are credited manually from the Telegram group, so
// a win message MUST eventually deliver. The pacing releases wins in
// top-of-hour bursts that exceed Telegram's ~1 message/second group limit,
// so first attempts routinely get 429'd; the sweep re-sends survivors with
// polite spacing until Telegram confirms.

// Give up after this many attempts and page the owner instead — at 5-minute
// sweeps this is ~an hour of trying, far beyond any transient outage.
export const MAX_ATTEMPTS = 12;

// Do not hammer a row: a fresh attempt must be at least this old before the
// sweep retries it (also skips rows the spin request is still working on).
export const RETRY_COOLDOWN_MS = 60 * 1000;

// Spacing between sends within one sweep run — just under Telegram's
// per-chat tolerance.
export const SEND_SPACING_MS = 1200;

// How many sends one sweep run attempts. 8 × 1.2s fits comfortably inside
// the function's execution window; the next run is 5 minutes away.
export const SWEEP_BATCH = 8;

// A pending row older than this means the pipeline is stuck — alert.
export const STUCK_AFTER_MS = 30 * 60 * 1000;

export function sweepEligible(row, nowMs = Date.now()) {
  if (!row || row.status !== 'pending') return false;
  if ((row.attempts || 0) >= MAX_ATTEMPTS) return false;
  if (!row.last_attempt_at) return true;
  const last = new Date(row.last_attempt_at).getTime();
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= RETRY_COOLDOWN_MS;
}
