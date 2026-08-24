// Pure maths for the promo wheel. No DOM. Everything the component needs to
// know about WHERE to stop and HOW the angle evolves over time lives here so
// it can be tested without a browser.

// Slice 0 starts at 12 o'clock and slices run clockwise. Each of the five
// outcomes appears twice so the wheel reads as full.
//
// Colours are the money wheel's own (components/WheelWidget.jsx): K20/K50/K100
// use the exact slice colours those prizes have there, losses use its grey,
// and the free-spins slice takes the jackpot's red-marquee treatment
// (`marquee: true`) — the promo wheel must read as the same machine.
export const PROMO_SEGMENTS = [
  { id: 'k100',      label: 'K100',          color: '#ffd600' },
  { id: 'k20',       label: 'K20',           color: '#d500f9' },
  { id: 'k50',       label: 'K50',           color: '#ff6d00' },
  { id: 'freespins', label: '50 FREE SPINS', color: '#c50e1f', marquee: true, win: true },
  { id: 'lose',      label: 'LOSE',          color: '#78909c', isLoss: true },
  { id: 'k100',      label: 'K100',          color: '#ffd600' },
  { id: 'k20',       label: 'K20',           color: '#d500f9' },
  { id: 'k50',       label: 'K50',           color: '#ff6d00' },
  { id: 'freespins', label: '50 FREE SPINS', color: '#c50e1f', marquee: true, win: true },
  { id: 'lose',      label: 'LOSE',          color: '#78909c', isLoss: true },
];

export const SEGMENT_DEG = 360 / PROMO_SEGMENTS.length;
export const WIN_INDICES = PROMO_SEGMENTS.map((s, i) => (s.win ? i : -1)).filter((i) => i >= 0);

// Which slice sits under the fixed pointer at 12 o'clock when the wheel
// element is rotated by `rotationDeg` clockwise. Slice k occupies
// [k*SEG, (k+1)*SEG) in the wheel's own frame; rotating the wheel clockwise
// by r brings the slice at (-r) under the pointer.
export function segmentAtPointer(rotationDeg) {
  const inWheel = (((-rotationDeg) % 360) + 360) % 360;
  return Math.floor(inWheel / SEGMENT_DEG) % PROMO_SEGMENTS.length;
}

// A final rotation (degrees, clockwise, several full turns included) that
// puts one of the win slices under the pointer, at a random offset inside
// the middle 70% of the slice so the pointer never sits on an edge.
export function landingAngle(rnd = Math.random) {
  const idx = WIN_INDICES[Math.floor(rnd() * WIN_INDICES.length)];
  const offset = SEGMENT_DEG * (0.15 + 0.70 * rnd());      // 5.4° .. 30.6°
  const turns = 5 + Math.floor(rnd() * 2);                  // 5 or 6 full turns
  // The wheel-frame angle we want under the pointer is idx*SEG + offset;
  // rotation r satisfies (-r mod 360) == that, so r = 360 - that (mod 360).
  const base = (360 - (idx * SEGMENT_DEG + offset)) % 360;
  return turns * 360 + base;
}

// Three phases, in ms. accel: 0 → full speed; cruise: full speed; ease:
// cubic ease-out into the target. Kept as a table so the component and the
// tests share one source of truth.
export const SPIN_PHASES = { accel: 900, cruise: 2200, ease: 3200 };
export const TOTAL_MS = SPIN_PHASES.accel + SPIN_PHASES.cruise + SPIN_PHASES.ease;

// Degrees covered during accel + cruise, as a fraction of the target. The
// ease phase then covers the rest. 0.55 makes the final slow-down visibly
// long without the wheel appearing to stall.
const PRE_EASE_SHARE = 0.55;

// Wheel rotation at time t (ms since SPIN) for a given final target angle.
// Monotonic non-decreasing; equals target for t >= TOTAL_MS.
export function angleAt(t, target) {
  if (t <= 0) return 0;
  if (t >= TOTAL_MS) return target;
  const { accel, cruise, ease } = SPIN_PHASES;
  const preEase = target * PRE_EASE_SHARE;
  // Constant-acceleration ramp then constant speed: distance = v*(accel/2 + cruise)
  const v = preEase / (accel / 2 + cruise);              // deg per ms at cruise
  if (t < accel) return 0.5 * v * (t * t) / accel;
  if (t < accel + cruise) return 0.5 * v * accel + v * (t - accel);
  const u = (t - accel - cruise) / ease;                 // 0..1 in ease
  const eased = 1 - Math.pow(1 - u, 3);
  return preEase + (target - preEase) * eased;
}
