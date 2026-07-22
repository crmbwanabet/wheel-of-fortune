import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previousWheelDayWindowUtc } from './wheelTime.js';

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
