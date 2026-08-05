import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cooldownDigestLines } from './cooldownDigest.js';

// A cooldown-blocked prize is queued on wheel_daily_state.carryover_prizes and
// awarded to the next qualifying spinner. Since 2026-08-05 an unclaimed queue is
// carried into the next wheel-day rather than orphaned at the 04:00 UTC reset —
// so a carried-in prize is paid out of TODAY's budget and has to be explained,
// and a remaining shortfall now points at the carry-forward itself.

test('a quiet day produces no cooldown lines at all', () => {
  assert.deepEqual(cooldownDigestLines(0, 0, []), []);
});

test('a fully drained queue reports the counts without a warning', () => {
  assert.deepEqual(cooldownDigestLines(1, 1, []), [
    'Cooldown: 1 blocked → 1 passed to other players',
  ]);
});

test('an uncollected prize warns that it should reach tomorrow', () => {
  assert.deepEqual(cooldownDigestLines(1, 0, []), [
    'Cooldown: 1 blocked → 0 passed to other players',
    '⚠️ 1 blocked prize still uncollected — should be carried to tomorrow; check if it arrives',
  ]);
});

test('the warning pluralises on more than one stranded prize', () => {
  const lines = cooldownDigestLines(3, 1, []);
  assert.equal(
    lines[1],
    '⚠️ 2 blocked prizes still uncollected — should be carried to tomorrow; check if it arrives'
  );
});

test('a carried-in prize is reported with its total and its budget impact', () => {
  assert.deepEqual(cooldownDigestLines(0, 0, [50]), [
    "Carried in from yesterday: K50 (1 prize) — counts against today's budget",
  ]);
});

test('several carried-in prizes are summed and pluralised', () => {
  assert.deepEqual(cooldownDigestLines(0, 0, [50, 100]), [
    "Carried in from yesterday: K150 (2 prizes) — counts against today's budget",
  ]);
});

test('carried-in appears alongside the cooldown counts, in order', () => {
  assert.deepEqual(cooldownDigestLines(1, 1, [20]), [
    'Cooldown: 1 blocked → 1 passed to other players',
    "Carried in from yesterday: K20 (1 prize) — counts against today's budget",
  ]);
});

test('an empty or absent carry-in adds nothing', () => {
  assert.deepEqual(cooldownDigestLines(1, 1, []), [
    'Cooldown: 1 blocked → 1 passed to other players',
  ]);
  assert.deepEqual(cooldownDigestLines(1, 1, null), [
    'Cooldown: 1 blocked → 1 passed to other players',
  ]);
  assert.deepEqual(cooldownDigestLines(1, 1, undefined), [
    'Cooldown: 1 blocked → 1 passed to other players',
  ]);
});

test('non-numeric junk inside the carry-in array is ignored, not summed', () => {
  // carryover_in is jsonb straight from the database. A malformed entry must
  // not produce "KNaN" in the owner's Telegram.
  assert.deepEqual(cooldownDigestLines(0, 0, [50, null, 'x']), [
    "Carried in from yesterday: K50 (1 prize) — counts against today's budget",
  ]);
  assert.deepEqual(cooldownDigestLines(0, 0, ['x']), []);
});

test('prizes passed on without any block still report', () => {
  assert.deepEqual(cooldownDigestLines(0, 1, []), [
    'Cooldown: 0 blocked → 1 passed to other players',
  ]);
});

test('collected exceeding blocked never warns — a negative shortfall is not a shortfall', () => {
  assert.deepEqual(cooldownDigestLines(1, 2, []), [
    'Cooldown: 1 blocked → 2 passed to other players',
  ]);
});

test('null and undefined counts are treated as zero, not printed literally', () => {
  // Supabase returns `count: null` when the head-count query errors, and the
  // route reads it straight through. "Cooldown: null blocked" would be worse
  // than silence.
  assert.deepEqual(cooldownDigestLines(null, undefined, null), []);
  assert.deepEqual(cooldownDigestLines(2, null, []), [
    'Cooldown: 2 blocked → 0 passed to other players',
    '⚠️ 2 blocked prizes still uncollected — should be carried to tomorrow; check if it arrives',
  ]);
});
