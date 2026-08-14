import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLanding, LANDING_MAX_MS, LANDING_MIN_MS } from './wheelLanding.js';

// The wheel friction-brakes while it waits for /api/spin, and the landing was
// derived straight from whatever speed was left: duration = decelTotal*50/speed.
// BRAKE_FRICTION is 0.98 per frame, so the speed halves roughly every 0.6s —
// after five seconds of waiting it is ~0.05, and that formula yields a landing
// of about NINETEEN MINUTES. The wheel simply looks frozen.
//
// It matters more now that a failed spin makes a second round-trip to recover
// the real result, which is exactly the slow path where this bites.

test('a fast wheel lands with the original feel', () => {
  const { decelTotal, duration } = computeLanding(20, 180);
  assert.equal(decelTotal, 4 * 360 + 180);   // 4 extra rotations above speed 12
  assert.equal(duration, Math.max(LANDING_MIN_MS, decelTotal * 50 / 20));
  assert.ok(duration >= LANDING_MIN_MS && duration <= LANDING_MAX_MS);
});

test('mid speeds keep their rotation counts', () => {
  assert.equal(computeLanding(10, 0).decelTotal, 3 * 360);   // >6
  assert.equal(computeLanding(5, 0).decelTotal, 2 * 360);    // <=6
});

test('the landing never takes longer than the cap, however slow the wheel', () => {
  for (const speed of [1, 0.5, 0.05, 0.001, 0]) {
    const { duration } = computeLanding(speed, 359);
    assert.ok(
      duration <= LANDING_MAX_MS,
      `speed ${speed} produced a ${Math.round(duration)}ms landing`,
    );
  }
});

// The specific regression: five seconds of braking used to mean ~19 minutes.
test('a wheel that braked for five seconds still lands promptly', () => {
  const speedAfter5s = 20 * Math.pow(0.98, 300);   // ≈0.047
  const { duration } = computeLanding(speedAfter5s, 200);
  assert.ok(duration <= LANDING_MAX_MS, `got ${Math.round(duration)}ms`);
});

test('the landing is never shorter than the minimum, so it stays visible', () => {
  for (const speed of [200, 60, 20]) {
    assert.ok(computeLanding(speed, 10).duration >= LANDING_MIN_MS);
  }
});

test('a nearly stopped wheel does not add extra rotations it cannot sell', () => {
  // easeOutCubic starts fast; asking a standstill for four rotations is a jump.
  assert.equal(computeLanding(0.02, 90).decelTotal, 90);
  assert.equal(computeLanding(0, 250).decelTotal, 250);
});

test('remaining degrees are always travelled, so the wheel lands on target', () => {
  for (const speed of [20, 8, 3, 0.01]) {
    const { decelTotal } = computeLanding(speed, 123);
    assert.equal(decelTotal % 360, 123, `speed ${speed} missed the target segment`);
  }
});

test('a negative or non-finite speed is treated as stopped, not as an error', () => {
  for (const bad of [-5, NaN, Infinity, undefined]) {
    const { duration, decelTotal } = computeLanding(bad, 100);
    assert.ok(Number.isFinite(duration), `duration not finite for ${String(bad)}`);
    assert.ok(Number.isFinite(decelTotal), `decelTotal not finite for ${String(bad)}`);
    assert.ok(duration <= LANDING_MAX_MS);
  }
});
