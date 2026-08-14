import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySpinRecovery } from './spinRecovery.js';

// The widget used to fabricate a RANDOM LOSS whenever the spin request failed.
// That is a lie in a specific and expensive direction: the server may already
// have committed the spin, and if it committed a WIN the customer was shown a
// loss and never found out. Two of the nine spin_network_error reports between
// 2026-08-11 and 08-14 had a spin recorded within ~3s of the error.
//
// These cases decide what the widget is ENTITLED TO CLAIM after a failed spin,
// given whatever /api/spin-status can tell it. The guiding rule: never assert an
// outcome the server did not confirm.

const SEGMENTS = 8;

test('a recorded losing spin is recovered as the real loss', () => {
  const r = classifySpinRecovery(
    { available: false, reason: 'already_spun', result: { segmentIndex: 3, won: false, prizeAmount: 0 } },
    SEGMENTS,
  );
  assert.equal(r.kind, 'recovered');
  assert.equal(r.segmentIndex, 3);
  assert.equal(r.won, false);
  assert.equal(r.prizeAmount, 0);
});

// The whole reason this module exists.
test('a recorded WINNING spin is recovered as a win, not a loss', () => {
  const r = classifySpinRecovery(
    { available: false, reason: 'already_spun', result: { segmentIndex: 5, won: true, prizeAmount: 50 } },
    SEGMENTS,
  );
  assert.equal(r.kind, 'recovered');
  assert.equal(r.segmentIndex, 5);
  assert.equal(r.won, true);
  assert.equal(r.prizeAmount, 50);
});

test('segment index 0 is a real segment, not a falsy miss', () => {
  const r = classifySpinRecovery(
    { available: false, result: { segmentIndex: 0, won: false, prizeAmount: 0 } },
    SEGMENTS,
  );
  assert.equal(r.kind, 'recovered');
  assert.equal(r.segmentIndex, 0);
});

test('no spin on record means the spin was never used — safe to retry', () => {
  const r = classifySpinRecovery({ available: true, reason: 'available' }, SEGMENTS);
  assert.equal(r.kind, 'not_spun');
});

// spin-status FAILS OPEN: a DB error returns available:true so a hiccup cannot
// suppress the wheel for the day. That makes available:true unreliable HERE —
// treating it as "not spun" would invite a retry that the server then rejects
// as already_spun, landing us right back on a fabricated loss.
test('a failed-open status is not proof the spin was unused', () => {
  const r = classifySpinRecovery({ available: true, reason: 'check_failed' }, SEGMENTS);
  assert.equal(r.kind, 'unknown');
});

test('maintenance mode tells us nothing about the spin', () => {
  const r = classifySpinRecovery({ available: false, maintenance: true, reason: 'maintenance' }, SEGMENTS);
  assert.equal(r.kind, 'unknown');
});

test('an auth failure tells us nothing about the spin', () => {
  const r = classifySpinRecovery({ available: false, error: 'token_expired', reason: 'token_expired' }, SEGMENTS);
  assert.equal(r.kind, 'unknown');
});

test('the recovery request itself failing yields unknown, never a result', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    assert.equal(classifySpinRecovery(bad, SEGMENTS).kind, 'unknown', `for ${JSON.stringify(bad)}`);
  }
});

// The spin is gone either way, but we must not invent which segment it hit.
test('a spin on record with no result payload is spent but unknown', () => {
  const r = classifySpinRecovery({ available: false, reason: 'already_spun' }, SEGMENTS);
  assert.equal(r.kind, 'spent_unknown');
});

test('an out-of-range segment index is spent but unknown, never landed on', () => {
  for (const idx of [-1, SEGMENTS, SEGMENTS + 4, 1.5, NaN, '3', null]) {
    const r = classifySpinRecovery(
      { available: false, result: { segmentIndex: idx, won: false, prizeAmount: 0 } },
      SEGMENTS,
    );
    assert.equal(r.kind, 'spent_unknown', `index ${String(idx)} must not be landed on`);
  }
});

// A won flag without a prize amount is still a win; the amount is presentational.
test('a win with a missing prize amount still reports as won', () => {
  const r = classifySpinRecovery(
    { available: false, result: { segmentIndex: 2, won: true } },
    SEGMENTS,
  );
  assert.equal(r.kind, 'recovered');
  assert.equal(r.won, true);
  assert.equal(r.prizeAmount, 0);
});

// `won` is what the server committed. Never re-derive it from the segment.
test('the server won flag is trusted verbatim, not inferred', () => {
  const r = classifySpinRecovery(
    { available: false, result: { segmentIndex: 1, won: true, prizeAmount: 20 } },
    SEGMENTS,
  );
  assert.equal(r.won, true);
});

test('a non-boolean won flag is coerced, not passed through raw', () => {
  const r = classifySpinRecovery(
    { available: false, result: { segmentIndex: 1, won: 'yes', prizeAmount: 20 } },
    SEGMENTS,
  );
  assert.equal(r.kind, 'recovered');
  assert.equal(r.won, true);
});
