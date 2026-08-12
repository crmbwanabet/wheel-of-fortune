// Pure UTC math for the FCFS payout model's qualifying-deposit window.
//
// The wheel day resets at 06:00 CAT. Zambia is CAT = UTC+2 (no DST), so the
// reset is 04:00 UTC. Everything here is computed in UTC on purpose — server
// local time must never be trusted (some hosts even mislabel Africa/Lusaka).
// The qualifying window is the last N wheel-days plus today-so-far (up to the
// spin moment).

const CAT_OFFSET_MS = 2 * 60 * 60 * 1000; // UTC+2
const DAY_MS = 24 * 60 * 60 * 1000;

// Qualifying-deposit window for the FCFS payout model: the last `days` full
// wheel-days PLUS today-so-far. Lower bound = current wheel-day start − days;
// upper bound = the spin moment, so a deposit made today qualifies immediately.
export function qualifyingWindowUtc(nowMs, days = 7) {
  const cat = new Date(nowMs + CAT_OFFSET_MS);
  let y = cat.getUTCFullYear();
  let m = cat.getUTCMonth();
  let d = cat.getUTCDate();
  // Before 06:00 CAT we are still on the previous wheel-day.
  if (cat.getUTCHours() < 6) {
    const rolled = new Date(Date.UTC(y, m, d - 1));
    y = rolled.getUTCFullYear();
    m = rolled.getUTCMonth();
    d = rolled.getUTCDate();
  }
  const curStartMs = Date.UTC(y, m, d, 4, 0, 0, 0); // 04:00 UTC of the wheel-day
  return { startMs: curStartMs - days * DAY_MS, endMs: nowMs };
}
