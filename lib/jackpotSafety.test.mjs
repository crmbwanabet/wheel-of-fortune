import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALGORITHMS, generatePrizePool, prizeToSegmentIndex,
  VALID_PRIZE_AMOUNTS,
} from './algorithms.js';
import {
  WIN_SEGMENTS, LOSS_SEGMENTS, JACKPOT_SEGMENT_INDEX, SEGMENT_COUNT,
} from './wheelSegments.js';

// ============================================================================
// AUDITABLE PROOF: the K10,000 jackpot segment is display-only and can never
// be won. Spec 2026-08-19-prize-ladder-pacing-jackpot-design.md §4.4.
// This file must never be deleted or weakened — fix the source instead.
// ============================================================================

const JACKPOT_AMOUNT = 10000;

// Guarantee 1: the jackpot amount can never be generated into a prize pool.
test('no algorithm can emit K10,000', () => {
  for (const id of Object.keys(ALGORITHMS)) {
    assert.ok(!Object.keys(ALGORITHMS[id].prizes).includes(String(JACKPOT_AMOUNT)));
    for (const p of generatePrizePool(Number(id))) {
      assert.notEqual(p, JACKPOT_AMOUNT);
    }
  }
});

// Guarantee 2: there is no forward mapping from the jackpot amount.
test('prizeToSegmentIndex(10000) throws', () => {
  assert.throws(() => prizeToSegmentIndex(JACKPOT_AMOUNT), /Unknown prize amount/);
});

test('K10,000 is not a valid prize amount', () => {
  assert.ok(!VALID_PRIZE_AMOUNTS.includes(JACKPOT_AMOUNT));
});

// Guarantee 5: the jackpot index belongs to neither reachable set.
test('jackpot index is in neither the win nor the loss set', () => {
  assert.ok(!WIN_SEGMENTS.includes(JACKPOT_SEGMENT_INDEX));
  assert.ok(!LOSS_SEGMENTS.includes(JACKPOT_SEGMENT_INDEX));
});

test('win and loss sets together cover every segment except the jackpot', () => {
  const reachable = [...WIN_SEGMENTS, ...LOSS_SEGMENTS].sort((a, b) => a - b);
  const expected = Array.from({ length: SEGMENT_COUNT }, (_, i) => i)
    .filter(i => i !== JACKPOT_SEGMENT_INDEX);
  assert.deepEqual(reachable, expected);
});

test('win and loss sets do not overlap', () => {
  assert.equal(WIN_SEGMENTS.filter(i => LOSS_SEGMENTS.includes(i)).length, 0);
});

// Exhaustive: every prize of every algorithm maps somewhere that is not the jackpot.
test('exhaustive: no prize in any algorithm maps to the jackpot segment', () => {
  for (const id of Object.keys(ALGORITHMS)) {
    for (const amount of Object.keys(ALGORITHMS[id].prizes)) {
      const seg = prizeToSegmentIndex(Number(amount));
      assert.notEqual(seg, JACKPOT_SEGMENT_INDEX);
      assert.ok(seg >= 0 && seg < SEGMENT_COUNT);
    }
  }
});
