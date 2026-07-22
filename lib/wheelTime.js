// Pure UTC math for the "previous wheel-day" deposit window.
//
// The wheel day resets at 06:00 CAT. Zambia is CAT = UTC+2 (no DST), so the
// reset is 04:00 UTC. Everything here is computed in UTC on purpose — server
// local time must never be trusted (some hosts even mislabel Africa/Lusaka).

const CAT_OFFSET_MS = 2 * 60 * 60 * 1000; // UTC+2
const DAY_MS = 24 * 60 * 60 * 1000;

// Given a wall-clock instant (ms since epoch), return the UTC [start, end) of
// the PREVIOUS wheel-day: prevStartMs (inclusive) .. curStartMs (exclusive).
export function previousWheelDayWindowUtc(nowMs) {
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
  const prevStartMs = curStartMs - DAY_MS;
  return { prevStartMs, curStartMs };
}
