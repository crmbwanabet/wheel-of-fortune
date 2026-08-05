// Digest reporting for the win cooldown.
//
// A cooldown-blocked prize is queued on wheel_daily_state.carryover_prizes and
// awarded to the next qualifying spinner. That queue is scoped to ONE wheel-day:
// at 06:00 CAT a fresh state row is created with an empty queue, so anything
// still queued is silently lost and the day's payout quietly under-runs the
// K2,000 budget. Nothing else in the system reports that, which is why the
// digest warns on it — `blocked > passedOn` at end of day IS the shortfall.

function count(n) {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Lines to append to the daily digest. Empty when the cooldown never fired —
// it blocks roughly 0–1 wins/day, so a permanent "0 blocked" line would be noise.
export function cooldownDigestLines(blocked, passedOn) {
  const b = count(blocked);
  const p = count(passedOn);
  if (b === 0 && p === 0) return [];

  const lines = [`Cooldown: ${b} blocked → ${p} passed to other players`];
  const stranded = b - p;
  if (stranded > 0) {
    lines.push(
      `⚠️ ${stranded} blocked ${stranded === 1 ? 'prize was' : 'prizes were'} never collected` +
      ' and expired at the 06:00 reset'
    );
  }
  return lines;
}
