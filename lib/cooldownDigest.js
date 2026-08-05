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
//
// `carriedIn` is wheel_daily_state.carryover_in: prizes handed to this day by
// the previous one because they never found a collector before the reset. They
// are paid out of TODAY's budget, so without this line the day looks like an
// overspend against K2,000 for no visible reason.
export function cooldownDigestLines(blocked, passedOn, carriedIn) {
  const b = count(blocked);
  const p = count(passedOn);
  const carried = Array.isArray(carriedIn) ? carriedIn.filter((n) => Number.isFinite(n)) : [];
  if (b === 0 && p === 0 && carried.length === 0) return [];

  const lines = [];
  if (b > 0 || p > 0) {
    lines.push(`Cooldown: ${b} blocked → ${p} passed to other players`);
  }
  if (carried.length > 0) {
    const total = carried.reduce((sum, n) => sum + n, 0);
    lines.push(
      `Carried in from yesterday: K${total}` +
      ` (${carried.length} ${carried.length === 1 ? 'prize' : 'prizes'}) — counts against today's budget`
    );
  }
  // A shortfall now means the queue did not drain even after being carried
  // forward, which points at the carry-forward itself rather than at a prize
  // simply running out of day.
  const stranded = b - p;
  if (stranded > 0) {
    lines.push(
      `⚠️ ${stranded} blocked ${stranded === 1 ? 'prize' : 'prizes'} still uncollected` +
      ' — should be carried to tomorrow; check if it arrives'
    );
  }
  return lines;
}
