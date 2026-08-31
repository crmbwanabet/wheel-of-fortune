import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOX_LABELS, gameForWheelDay, resolveGame, boxDecoys } from './gameRotation.js';

test('nine box labels, matching the wheel prize ladder plus jackpot and losses', () => {
  assert.equal(BOX_LABELS.length, 9);
  ['K5', 'K10', 'K20', 'K50', 'K100', 'K200', 'K10,000'].forEach((l) =>
    assert.ok(BOX_LABELS.includes(l), l));
  assert.equal(BOX_LABELS.filter((l) => l === 'TRY AGAIN').length, 2);
});

test('the game flips on consecutive wheel-days and is deterministic', () => {
  const a = gameForWheelDay('2026-08-26');
  const b = gameForWheelDay('2026-08-27');
  const c = gameForWheelDay('2026-08-28');
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.equal(a, c);
  assert.equal(gameForWheelDay('2026-08-26'), a);
  assert.equal(gameForWheelDay('garbage'), 'wheel');
});

test('?game= overrides the rotation; junk falls back to it', () => {
  assert.equal(resolveGame('?game=box', '2026-08-26'), 'box');
  assert.equal(resolveGame('?test=1&game=wheel', '2026-08-27'), 'wheel');
  assert.equal(resolveGame('?game=nope', '2026-08-26'), gameForWheelDay('2026-08-26'));
  assert.equal(resolveGame('', '2026-08-26'), gameForWheelDay('2026-08-26'));
});

test('boxDecoys removes exactly one occurrence of the result label', () => {
  const d = boxDecoys('K200');
  assert.equal(d.length, 8);
  assert.ok(!d.includes('K200') || BOX_LABELS.filter((l) => l === 'K200').length > 1);
  const losses = boxDecoys('TRY AGAIN');
  assert.equal(losses.filter((l) => l === 'TRY AGAIN').length, 1);
});

test('a win label not in the set removes a loss box instead', () => {
  const d = boxDecoys('K75');
  assert.equal(d.length, 8);
  assert.equal(d.filter((l) => l === 'TRY AGAIN').length, 1);
});

test('a stuck RNG still returns 8 labels', () => {
  assert.equal(boxDecoys('K5', () => 0).length, 8);
  assert.equal(boxDecoys('K5', () => 0.999999).length, 8);
});
