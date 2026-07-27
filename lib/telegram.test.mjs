import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catTimestamp } from './telegram.js';

test('catTimestamp renders CAT (UTC+2), not UTC', () => {
  // 06:47 UTC on 2026-07-25 is 08:47 CAT.
  const utc = Date.parse('2026-07-25T06:47:00Z');
  assert.equal(catTimestamp(utc), '2026-07-25 08:47:00 CAT');
});

test('catTimestamp rolls the date across the UTC→CAT midnight boundary', () => {
  // 23:30 UTC → 01:30 next-day CAT.
  const utc = Date.parse('2026-07-25T23:30:00Z');
  assert.equal(catTimestamp(utc), '2026-07-26 01:30:00 CAT');
});
