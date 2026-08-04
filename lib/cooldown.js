// Win-cooldown window arithmetic. Mirrors the SQL inside claim_spin so the
// semantics are tested in one place and reusable by the verification script.
//
// Rule: a customer who won on wheel-day D cannot win on D+1 .. D+n.
// Expressed at spin time on day P, a past win blocks the spin when it falls in
// [P - n, P - 1] inclusive — the SQL equivalent of
//   day_date >= p_day - p_cooldown_days AND day_date < p_day
//
// Days are wheel-day strings ('YYYY-MM-DD') as produced by getWheelDayDate().
// All arithmetic is UTC so it never depends on server local time. Wheel-day
// strings are zero-padded and fixed-width, so lexicographic comparison is
// equivalent to chronological comparison.

export const DEFAULT_COOLDOWN_DAYS = 3;

// Parse SPIN_COOLDOWN_DAYS. Absent, non-numeric, negative or fractional values
// fall back to the default. 0 is valid and disables the rule (kill-switch).
export function resolveCooldownDays(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_COOLDOWN_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_COOLDOWN_DAYS;
  return n;
}

// Move a wheel-day string by `delta` days, in UTC.
export function shiftWheelDay(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

// Inclusive [from, to] range of wheel-days whose wins block a spin on `day`.
// Returns null when the cooldown is disabled.
export function cooldownWindow(day, cooldownDays) {
  if (!(cooldownDays > 0)) return null;
  return { from: shiftWheelDay(day, -cooldownDays), to: shiftWheelDay(day, -1) };
}

// True when a win on `winDay` blocks a spin on `spinDay`.
export function blocksSpin(winDay, spinDay, cooldownDays) {
  const w = cooldownWindow(spinDay, cooldownDays);
  if (!w) return false;
  return winDay >= w.from && winDay <= w.to;
}
