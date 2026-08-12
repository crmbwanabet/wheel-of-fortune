import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previousWheelDayWindowUtc, qualifyingWindowUtc } from './wheelTime.js';

// Wheel day flips at 06:00 CAT = 04:00 UTC. "Previous wheel-day" window is
// [curStart - 24h, curStart), all in UTC.

test('spin exactly at 06:00 CAT (04:00 UTC) -> window is the whole prior wheel-day', () => {
  const now = Date.parse('2026-07-21T04:00:00Z');
  const { prevStartMs, curStartMs } = previousWheelDayWindowUtc(now);
  assert.equal(new Date(curStartMs).toISOString(), '2026-07-21T04:00:00.000Z');
  assert.equal(new Date(prevStartMs).toISOString(), '2026-07-20T04:00:00.000Z');
});

test('spin mid-afternoon CAT stays on the same wheel-day', () => {
  const now = Date.parse('2026-07-21T12:00:00Z'); // 14:00 CAT
  const { prevStartMs, curStartMs } = previousWheelDayWindowUtc(now);
  assert.equal(new Date(curStartMs).toISOString(), '2026-07-21T04:00:00.000Z');
  assert.equal(new Date(prevStartMs).toISOString(), '2026-07-20T04:00:00.000Z');
});

test('before 06:00 CAT the wheel-day is still yesterday, so window rolls back one more day', () => {
  const now = Date.parse('2026-07-21T03:59:00Z'); // 05:59 CAT — before reset
  const { prevStartMs, curStartMs } = previousWheelDayWindowUtc(now);
  assert.equal(new Date(curStartMs).toISOString(), '2026-07-20T04:00:00.000Z');
  assert.equal(new Date(prevStartMs).toISOString(), '2026-07-19T04:00:00.000Z');
});

test('month boundary rolls back correctly', () => {
  const now = Date.parse('2026-08-01T05:00:00Z'); // 07:00 CAT on Aug 1 wheel-day
  const { prevStartMs, curStartMs } = previousWheelDayWindowUtc(now);
  assert.equal(new Date(curStartMs).toISOString(), '2026-08-01T04:00:00.000Z');
  assert.equal(new Date(prevStartMs).toISOString(), '2026-07-31T04:00:00.000Z');
});

test('pre-06:00-CAT rollback across a year boundary (Jan 1) normalizes to prior year', () => {
  const now = Date.parse('2026-01-01T03:00:00Z'); // 05:00 CAT on Jan 1 — before reset
  const { prevStartMs, curStartMs } = previousWheelDayWindowUtc(now);
  // wheel-day is still Dec 31, 2025 -> curStart = 2025-12-31T04:00Z
  assert.equal(new Date(curStartMs).toISOString(), '2025-12-31T04:00:00.000Z');
  assert.equal(new Date(prevStartMs).toISOString(), '2025-12-30T04:00:00.000Z');
});

// qualifyingWindowUtc: [current wheel-day start − N days, nowMs] — the upper
// bound is the spin moment so same-day deposits qualify immediately.

test('7-day window mid-afternoon: start is 7 days before today 04:00 UTC, end is now', () => {
  const now = Date.parse('2026-08-12T12:00:00Z'); // 14:00 CAT, wheel-day 2026-08-12
  const { startMs, endMs } = qualifyingWindowUtc(now, 7);
  assert.equal(new Date(startMs).toISOString(), '2026-08-05T04:00:00.000Z');
  assert.equal(endMs, now);
});

test('before 06:00 CAT the wheel-day is still yesterday, so the window shifts back a day', () => {
  const now = Date.parse('2026-08-12T03:59:00Z'); // 05:59 CAT — wheel-day 2026-08-11
  const { startMs, endMs } = qualifyingWindowUtc(now, 7);
  assert.equal(new Date(startMs).toISOString(), '2026-08-04T04:00:00.000Z');
  assert.equal(endMs, now);
});

test('days=1 reproduces the old previous-wheel-day lower bound', () => {
  const now = Date.parse('2026-07-21T12:00:00Z');
  const { startMs } = qualifyingWindowUtc(now, 1);
  assert.equal(new Date(startMs).toISOString(), '2026-07-20T04:00:00.000Z');
});

test('7-day window crosses a month boundary correctly', () => {
  const now = Date.parse('2026-08-03T10:00:00Z'); // wheel-day 2026-08-03
  const { startMs } = qualifyingWindowUtc(now, 7);
  assert.equal(new Date(startMs).toISOString(), '2026-07-27T04:00:00.000Z');
});

test('pre-06:00-CAT Jan 1 rollback normalizes across the year boundary', () => {
  const now = Date.parse('2026-01-01T03:00:00Z'); // wheel-day 2025-12-31
  const { startMs } = qualifyingWindowUtc(now, 7);
  assert.equal(new Date(startMs).toISOString(), '2025-12-24T04:00:00.000Z');
});
