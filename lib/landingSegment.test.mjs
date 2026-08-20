import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLandingSegment } from './landingSegment.js';
import { WIN_SEGMENTS, LOSS_SEGMENTS, JACKPOT_SEGMENT_INDEX } from './wheelSegments.js';

const alwaysZero = () => 0;

test('a valid win index passes through unchanged', () => {
  for (const i of WIN_SEGMENTS) {
    assert.equal(resolveLandingSegment(i, alwaysZero).index, i);
    assert.equal(resolveLandingSegment(i, alwaysZero).substituted, false);
  }
});

test('a valid loss index passes through unchanged', () => {
  for (const i of LOSS_SEGMENTS) {
    assert.equal(resolveLandingSegment(i, alwaysZero).index, i);
  }
});

test('the jackpot index is never rendered', () => {
  const r = resolveLandingSegment(JACKPOT_SEGMENT_INDEX, alwaysZero);
  assert.notEqual(r.index, JACKPOT_SEGMENT_INDEX);
  assert.ok(LOSS_SEGMENTS.includes(r.index));
  assert.equal(r.substituted, true);
});

test('out-of-range indices fall back to a loss segment', () => {
  for (const bad of [-1, 14, 99, 2.5, NaN, null, undefined, '4']) {
    const r = resolveLandingSegment(bad, alwaysZero);
    assert.ok(LOSS_SEGMENTS.includes(r.index), `bad input ${bad} -> ${r.index}`);
    assert.equal(r.substituted, true);
  }
});

test('substitution uses the injected rng across the loss set', () => {
  assert.equal(resolveLandingSegment(99, () => 0).index, LOSS_SEGMENTS[0]);
  assert.equal(
    resolveLandingSegment(99, () => 0.999).index,
    LOSS_SEGMENTS[LOSS_SEGMENTS.length - 1],
  );
});
