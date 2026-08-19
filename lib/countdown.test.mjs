import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msUntilNextWheelReset, splitCountdown } from './countdown.js';

const at = (iso) => Date.parse(iso);
const HOUR = 3600_000;

// The wheel resets at 07:00 UTC (09:00 CAT). The countdown always points at the
// NEXT reset, so it is > 0 and <= 24h at every instant.

test('mid-morning, the next reset is 07:00 UTC the following day', () => {
  assert.equal(msUntilNextWheelReset(at('2026-08-05T10:00:00Z')), 21 * HOUR);
});

test('just before the reset, only minutes remain', () => {
  assert.equal(msUntilNextWheelReset(at('2026-08-05T06:59:00Z')), 60_000);
});

test('exactly at the reset, a full day remains', () => {
  assert.equal(msUntilNextWheelReset(at('2026-08-05T07:00:00Z')), 24 * HOUR);
});

test('one minute after the reset, just under a full day remains', () => {
  assert.equal(msUntilNextWheelReset(at('2026-08-05T07:01:00Z')), 24 * HOUR - 60_000);
});

test('the window rolls across a month boundary', () => {
  assert.equal(msUntilNextWheelReset(at('2026-07-31T23:00:00Z')), 8 * HOUR);
});

test('the result is always within (0, 24h]', () => {
  for (const iso of ['2026-01-01T00:00:00Z', '2026-02-28T04:00:00Z', '2026-12-31T23:59:00Z']) {
    const ms = msUntilNextWheelReset(at(iso));
    assert.ok(ms > 0 && ms <= 24 * HOUR, `${iso} gave ${ms}`);
  }
});

test('splitCountdown breaks milliseconds into whole hours and minutes', () => {
  assert.deepEqual(splitCountdown(14 * HOUR + 32 * 60_000), { hours: 14, minutes: 32 });
});

test('splitCountdown floors seconds away rather than rounding up', () => {
  assert.deepEqual(splitCountdown(59_999), { hours: 0, minutes: 0 });
});

test('splitCountdown clamps a negative to zero', () => {
  // A device clock running ahead produces this. It must render 0h 00m, never a
  // negative or NaN — this codebase already has diagnostics for clock skew.
  assert.deepEqual(splitCountdown(-5000), { hours: 0, minutes: 0 });
});

test('splitCountdown clamps junk to zero', () => {
  assert.deepEqual(splitCountdown(NaN), { hours: 0, minutes: 0 });
  assert.deepEqual(splitCountdown(undefined), { hours: 0, minutes: 0 });
});
