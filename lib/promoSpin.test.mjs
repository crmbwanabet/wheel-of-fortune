import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMO_SEGMENTS, SEGMENT_DEG, WIN_INDICES, SPIN_PHASES, TOTAL_MS,
  landingAngle, segmentAtPointer, angleAt,
} from './promoSpin.js';

test('ten segments, each outcome twice, alternating', () => {
  assert.equal(PROMO_SEGMENTS.length, 10);
  assert.equal(SEGMENT_DEG, 36);
  const labels = PROMO_SEGMENTS.map((s) => s.id);
  assert.deepEqual(labels.slice(0, 5), labels.slice(5));
  assert.deepEqual(WIN_INDICES, [3, 8]);
  assert.equal(PROMO_SEGMENTS[3].id, 'freespins');
  assert.equal(PROMO_SEGMENTS[8].id, 'freespins');
});

test('landingAngle always resolves to a free-spins segment (1000 samples)', () => {
  for (let i = 0; i < 1000; i++) {
    const a = landingAngle(Math.random);
    assert.ok(WIN_INDICES.includes(segmentAtPointer(a)), `angle ${a} landed on ${segmentAtPointer(a)}`);
  }
});

test('landingAngle stays inside the middle 70% of the slice', () => {
  const lo = landingAngle(() => 0);
  const hi = landingAngle(() => 0.999999);
  assert.ok(WIN_INDICES.includes(segmentAtPointer(lo)));
  assert.ok(WIN_INDICES.includes(segmentAtPointer(hi)));
  // Offset inside the slice, measured in the wheel's own frame.
  const inWheel = (a) => (((-a) % 360) + 360) % 360;
  const within = (a) => inWheel(a) % SEGMENT_DEG;
  assert.ok(within(lo) >= SEGMENT_DEG * 0.15 - 1e-6, `lo offset ${within(lo)}`);
  assert.ok(within(hi) <= SEGMENT_DEG * 0.85 + 1e-6, `hi offset ${within(hi)}`);
});

test('segmentAtPointer maps a wheel rotation to the slice under the top pointer', () => {
  assert.equal(segmentAtPointer(0), 0);
  assert.equal(segmentAtPointer(36), 9);
  assert.equal(segmentAtPointer(-36), 1);
  assert.equal(segmentAtPointer(360 * 5), 0);
});

test('phases sum to TOTAL_MS and angleAt is monotonic and ends exactly on target', () => {
  assert.equal(SPIN_PHASES.accel + SPIN_PHASES.cruise + SPIN_PHASES.ease, TOTAL_MS);
  const target = 5 * 360 + 123;
  let prev = -Infinity;
  for (let t = 0; t <= TOTAL_MS; t += 16) {
    const a = angleAt(t, target);
    assert.ok(a >= prev - 1e-9, `non-monotonic at t=${t}`);
    prev = a;
  }
  assert.equal(Math.round(angleAt(TOTAL_MS, target) * 1000) / 1000, target);
  assert.equal(angleAt(TOTAL_MS + 5000, target), target);
  assert.equal(angleAt(0, target), 0);
});
