import test from 'node:test';
import assert from 'node:assert/strict';
import { coord } from './svgCoord.js';

// The bug this guards against: Math.cos/Math.sin are implementation-defined in
// ECMAScript, so Vercel's Node and the visitor's browser can disagree on the
// last bit of a coordinate. React then sees the server's cx="59.047822466108016"
// against the client's cx="59.047822466108045", fails hydration (#418) and
// throws the whole root away to re-render on the client (#423) — which on a
// slow phone means taps on SPIN land on dead server HTML and are lost.

test('rounds to three decimals', () => {
  assert.equal(coord(1 / 3), 0.333);
  assert.equal(coord(59.047822466108016), 59.048);
  assert.equal(coord(-0.0004), -0);
  assert.equal(coord(12), 12);
});

test('the exact coordinate that broke hydration in production agrees across engines', () => {
  // Node computed …016, Chromium …045 for the same expression (light 31).
  assert.equal(coord(59.047822466108016), coord(59.047822466108045));
});

test('a one-ULP disagreement never survives into the rendered attribute', () => {
  // Every coordinate the promo wheel emits: 36 chasing lights, 10 pegs,
  // 10 slice arcs (start + end) and 10 dividers.
  const angles = [];
  for (let i = 0; i < 36; i++) angles.push([i * 10 - 90, 184, 200]);
  for (let i = 0; i < 18; i++) angles.push([i * 20 - 90, 184, 200]);
  for (let i = 0; i < 10; i++) angles.push([i * 36 - 90, 175, 200]);
  for (let i = 0; i <= 10; i++) angles.push([i * 36 - 90, 148, 150]);

  for (const [deg, r, origin] of angles) {
    for (const fn of [Math.cos, Math.sin]) {
      const exact = origin + r * fn((deg * Math.PI) / 180);
      // What another engine could plausibly return: the neighbouring doubles.
      for (const nudge of [1 - Number.EPSILON, 1, 1 + Number.EPSILON]) {
        assert.equal(coord(exact * nudge), coord(exact),
          `deg=${deg} r=${r} drifted: ${coord(exact * nudge)} vs ${coord(exact)}`);
      }
    }
  }
});

test('output never carries more than three decimals', () => {
  for (let i = 0; i < 360; i++) {
    const v = coord(200 + 184 * Math.cos((i * Math.PI) / 180));
    const decimals = (String(v).split('.')[1] || '').length;
    assert.ok(decimals <= 3, `${v} has ${decimals} decimals`);
  }
});
