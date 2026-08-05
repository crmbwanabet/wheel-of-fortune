// Countdown to the next free spin.
//
// The wheel-day resets at 06:00 CAT = 04:00 UTC. previousWheelDayWindowUtc
// already returns curStartMs — 04:00 UTC of the CURRENT wheel-day — so the next
// reset is always exactly one day after it. Reusing that helper keeps every
// wheel-day boundary in this codebase governed by one tested implementation
// rather than a second copy of the same date arithmetic.

import { previousWheelDayWindowUtc } from './wheelTime.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Milliseconds until the next 04:00 UTC boundary. Always within (0, DAY_MS].
export function msUntilNextWheelReset(nowMs) {
  const { curStartMs } = previousWheelDayWindowUtc(nowMs);
  return curStartMs + DAY_MS - nowMs;
}

// Whole hours and minutes. Clamps to zero rather than ever rendering a negative
// or NaN: a device clock running ahead of real time is common enough that the
// widget already ships diagnostics for it, and "-1h -3m" on a losing screen
// would read as broken to the customer.
export function splitCountdown(ms) {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return {
    hours: Math.floor(safe / 3600_000),
    minutes: Math.floor((safe % 3600_000) / 60_000),
  };
}
