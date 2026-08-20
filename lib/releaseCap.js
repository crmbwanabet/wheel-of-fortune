// Hourly payout pacing.
//
// The FCFS queue used to drain the whole day's K2,000 in about 70 minutes,
// leaving ~1,470 deposit-qualified players per day with a structurally
// impossible 0% win rate. This module spreads the pool across all 24
// wheel-day hours, shaped to the observed traffic curve so the win rate is
// roughly flat around the clock.
//
// The cap is CUMULATIVE, which is what gives rollover for free: quota unused
// in a quiet hour is still available later in the day. When queue_pos catches
// up to the cap, further eligible spins simply lose — the same code path as
// an empty pot.

import { currentWheelDayStartUtc } from './wheelTime.js';
import { POOL_SIZE } from './algorithms.js';

// Index = wheel-day hour (0 == 09:00 CAT, the reset). Shaped to the 7-day
// average spin distribution measured 2026-08-12..2026-08-18, rotated to the
// 09:00 day start — the day opens at the traffic peak. Sums to exactly
// POOL_SIZE.
export const HOURLY_QUOTAS = [
  20, 20, 20, 15, 12, 14, 9, 9, 10, 8, 6, 5,
  5, 5, 4, 2, 2, 1, 1, 1, 1, 6, 10, 14,
];

// Sentinel meaning "no pacing" — used for test traffic and as the rollback
// value. Matches the SQL default so the argument can simply be omitted.
export const UNPACED_CAP = 2147483647;

const HOUR_MS = 60 * 60 * 1000;

// Hours elapsed since the current wheel-day started, clamped to 0..23.
export function wheelHour(nowMs) {
  const elapsed = nowMs - currentWheelDayStartUtc(nowMs);
  return Math.min(23, Math.max(0, Math.floor(elapsed / HOUR_MS)));
}

// How many prizes may have been released in total by `nowMs`.
export function releaseCap(nowMs, quotas = HOURLY_QUOTAS) {
  const h = wheelHour(nowMs);
  let cap = 0;
  for (let i = 0; i <= h; i++) cap += quotas[i];
  return cap;
}

// Guard: a mis-edited table would silently mis-pace the day.
if (HOURLY_QUOTAS.reduce((a, b) => a + b, 0) !== POOL_SIZE) {
  throw new Error('HOURLY_QUOTAS must sum to POOL_SIZE');
}
