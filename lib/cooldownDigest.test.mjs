import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cooldownDigestLines } from './cooldownDigest.js';

// The carry-over queue lives on wheel_daily_state, keyed by wheel-day. A prize
// intercepted late in the day may never be collected before the 06:00 CAT
// reset, at which point the new day's row starts with an empty queue and the
// prize is gone. `blocked > passedOn` at digest time IS that shortfall, and it
// is the only signal we get — nothing else reports it.

test('a quiet day produces no cooldown lines at all', () => {
  assert.deepEqual(cooldownDigestLines(0, 0), []);
});

test('a fully drained queue reports the counts without a warning', () => {
  assert.deepEqual(cooldownDigestLines(1, 1), [
    'Cooldown: 1 blocked → 1 passed to other players',
  ]);
});

test('an uncollected prize adds a warning naming the shortfall', () => {
  assert.deepEqual(cooldownDigestLines(1, 0), [
    'Cooldown: 1 blocked → 0 passed to other players',
    '⚠️ 1 blocked prize was never collected and expired at the 06:00 reset',
  ]);
});

test('the warning pluralises on more than one stranded prize', () => {
  const lines = cooldownDigestLines(3, 1);
  assert.equal(lines[1], '⚠️ 2 blocked prizes were never collected and expired at the 06:00 reset');
});

test('prizes passed on without any block still report (the counts must be visible)', () => {
  assert.deepEqual(cooldownDigestLines(0, 1), [
    'Cooldown: 0 blocked → 1 passed to other players',
  ]);
});

test('collected exceeding blocked never warns — a negative shortfall is not a shortfall', () => {
  assert.deepEqual(cooldownDigestLines(1, 2), [
    'Cooldown: 1 blocked → 2 passed to other players',
  ]);
});

test('null and undefined counts are treated as zero, not printed literally', () => {
  // Supabase returns `count: null` when the head-count query errors, and the
  // route reads it straight through. A "Cooldown: null blocked" line in the
  // owner's Telegram would be worse than silence.
  assert.deepEqual(cooldownDigestLines(null, undefined), []);
  assert.deepEqual(cooldownDigestLines(2, null), [
    'Cooldown: 2 blocked → 0 passed to other players',
    '⚠️ 2 blocked prizes were never collected and expired at the 06:00 reset',
  ]);
});
