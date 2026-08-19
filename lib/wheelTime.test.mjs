import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualifyingWindowUtc } from './wheelTime.js';

// Wheel day flips at 09:00 CAT = 07:00 UTC. qualifyingWindowUtc returns the
// last N wheel-days plus today-so-far: [current wheel-day start − N days, nowMs].

// qualifyingWindowUtc: [current wheel-day start − N days, nowMs] — the upper
// bound is the spin moment so same-day deposits qualify immediately.

test('7-day window mid-afternoon: start is 7 days before today 07:00 UTC, end is now', () => {
  const now = Date.parse('2026-08-12T12:00:00Z'); // 14:00 CAT, wheel-day 2026-08-12
  const { startMs, endMs } = qualifyingWindowUtc(now, 7);
  assert.equal(new Date(startMs).toISOString(), '2026-08-05T07:00:00.000Z');
  assert.equal(endMs, now);
});

test('before 09:00 CAT the wheel-day is still yesterday, so the window shifts back a day', () => {
  const now = Date.parse('2026-08-12T06:59:00Z'); // 08:59 CAT — wheel-day 2026-08-11
  const { startMs, endMs } = qualifyingWindowUtc(now, 7);
  assert.equal(new Date(startMs).toISOString(), '2026-08-04T07:00:00.000Z');
  assert.equal(endMs, now);
});

test('days=1 reproduces the old previous-wheel-day lower bound', () => {
  const now = Date.parse('2026-07-21T12:00:00Z');
  const { startMs } = qualifyingWindowUtc(now, 1);
  assert.equal(new Date(startMs).toISOString(), '2026-07-20T07:00:00.000Z');
});

test('7-day window crosses a month boundary correctly', () => {
  const now = Date.parse('2026-08-03T10:00:00Z'); // wheel-day 2026-08-03
  const { startMs } = qualifyingWindowUtc(now, 7);
  assert.equal(new Date(startMs).toISOString(), '2026-07-27T07:00:00.000Z');
});

test('pre-09:00-CAT Jan 1 rollback normalizes across the year boundary', () => {
  const now = Date.parse('2026-01-01T06:00:00Z'); // wheel-day 2025-12-31
  const { startMs } = qualifyingWindowUtc(now, 7);
  assert.equal(new Date(startMs).toISOString(), '2025-12-24T07:00:00.000Z');
});
