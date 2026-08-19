import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOURLY_QUOTAS, wheelHour, releaseCap, UNPACED_CAP } from './releaseCap.js';
import { POOL_SIZE } from './algorithms.js';

// 04:00 UTC == 06:00 CAT == wheel hour 0.
const at = (iso) => Date.parse(iso);

test('quota table has 24 entries summing to the pool size', () => {
  assert.equal(HOURLY_QUOTAS.length, 24);
  assert.equal(HOURLY_QUOTAS.reduce((a, b) => a + b, 0), POOL_SIZE);
});

test('wheel hour 0 starts at 04:00 UTC', () => {
  assert.equal(wheelHour(at('2026-08-20T04:00:00Z')), 0);
  assert.equal(wheelHour(at('2026-08-20T04:59:59Z')), 0);
  assert.equal(wheelHour(at('2026-08-20T05:00:00Z')), 1);
});

test('wheel hour rolls through UTC midnight to 23', () => {
  assert.equal(wheelHour(at('2026-08-20T23:30:00Z')), 19);
  assert.equal(wheelHour(at('2026-08-21T00:30:00Z')), 20);
  assert.equal(wheelHour(at('2026-08-21T03:59:59Z')), 23);
});

test('just before the reset is still hour 23 of the previous wheel-day', () => {
  assert.equal(wheelHour(at('2026-08-21T03:00:00Z')), 23);
});

test('cap at hour 0 is the first quota', () => {
  assert.equal(releaseCap(at('2026-08-20T04:30:00Z')), HOURLY_QUOTAS[0]);
});

test('cap is cumulative — unused early quota stays available', () => {
  assert.equal(
    releaseCap(at('2026-08-20T06:30:00Z')),
    HOURLY_QUOTAS[0] + HOURLY_QUOTAS[1] + HOURLY_QUOTAS[2],
  );
});

test('cap is monotonically non-decreasing across the day', () => {
  let prev = 0;
  for (let h = 0; h < 24; h++) {
    const cap = releaseCap(at('2026-08-20T04:00:00Z') + h * 3600_000);
    assert.ok(cap >= prev, `cap fell at hour ${h}`);
    prev = cap;
  }
});

test('final hour releases the entire pool', () => {
  assert.equal(releaseCap(at('2026-08-21T03:30:00Z')), POOL_SIZE);
});

test('UNPACED_CAP disables pacing', () => {
  assert.ok(UNPACED_CAP > POOL_SIZE);
});
