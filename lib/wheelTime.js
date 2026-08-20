// Pure UTC math for wheel-day boundaries and the qualifying-deposit window.
//
// The wheel day resets at 09:00 CAT. Zambia is CAT = UTC+2 (no DST), so the
// reset is 07:00 UTC. Everything here is computed in UTC on purpose — server
// local time must never be trusted (some hosts even mislabel Africa/Lusaka).

const CAT_OFFSET_MS = 2 * 60 * 60 * 1000; // UTC+2
const DAY_MS = 24 * 60 * 60 * 1000;

// 07:00 UTC of the CURRENT wheel-day (rolls back a day before 09:00 CAT).
// The single source of truth for the wheel-day boundary — the qualifying
// window and the loss-screen countdown both derive from it.
export function currentWheelDayStartUtc(nowMs) {
  const cat = new Date(nowMs + CAT_OFFSET_MS);
  let y = cat.getUTCFullYear();
  let m = cat.getUTCMonth();
  let d = cat.getUTCDate();
  // Before 09:00 CAT we are still on the previous wheel-day.
  if (cat.getUTCHours() < 9) {
    const rolled = new Date(Date.UTC(y, m, d - 1));
    y = rolled.getUTCFullYear();
    m = rolled.getUTCMonth();
    d = rolled.getUTCDate();
  }
  return Date.UTC(y, m, d, 7, 0, 0, 0);
}

// Qualifying-deposit window for the FCFS payout model: the last `days` full
// wheel-days PLUS today-so-far. Lower bound = current wheel-day start − days;
// upper bound = the spin moment, so a deposit made today qualifies immediately.
export function qualifyingWindowUtc(nowMs, days = 7) {
  return { startMs: currentWheelDayStartUtc(nowMs) - days * DAY_MS, endMs: nowMs };
}
