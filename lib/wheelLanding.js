// How the wheel travels from "still braking" to "stopped on the winning
// segment", given how fast it is still turning when the result finally arrives.
//
// The wheel starts friction-braking the instant STOP is pressed and keeps
// braking until /api/spin answers, so the speed at that moment is a function of
// how slow the network was. The original formula read it straight:
//
//     duration = decelTotal * 50 / speed
//
// BRAKE_FRICTION is 0.98 per frame, which halves the speed about every 0.6s. A
// five-second wait leaves speed ≈ 0.047, and the formula then asks for a
// landing of roughly nineteen minutes — the wheel appears frozen and the
// customer never sees a result. Recovering a lost spin costs a second
// round-trip, which lands squarely in that window, so the floor and the cap
// below are what make that recovery actually reach the screen.
//
// Pure arithmetic: no DOM, no time, no refs.

export const LANDING_MIN_MS = 5000;   // always decelerate visibly
export const LANDING_MAX_MS = 9000;   // and always finish

// Below this the wheel is visually stopped. easeOutCubic leaves the gate fast,
// so asking a standstill for four more rotations reads as a jump rather than a
// landing — at these speeds it just travels the remaining degrees.
const NEAR_STOPPED = 1;

// brakingSpeed: degrees per 60fps frame, whatever is left when the result lands.
// remaining: degrees still to travel to reach the target segment (0..360).
// Returns { decelTotal, duration } for the easing phase.
export function computeLanding(brakingSpeed, remaining) {
  const speed = Number.isFinite(brakingSpeed) && brakingSpeed > 0 ? brakingSpeed : 0;

  // Showmanship scaled to what the wheel can still sell.
  const extraRotations = speed > 12 ? 4
                       : speed > 6 ? 3
                       : speed > NEAR_STOPPED ? 2
                       : 0;
  const decelTotal = extraRotations * 360 + remaining;

  // Floored so a near-zero speed cannot divide the duration to infinity, and
  // capped so no combination can outlast the customer's patience.
  const paceSpeed = Math.max(speed, NEAR_STOPPED);
  const duration = Math.min(
    LANDING_MAX_MS,
    Math.max(LANDING_MIN_MS, decelTotal * 50 / paceSpeed),
  );

  return { decelTotal, duration };
}
