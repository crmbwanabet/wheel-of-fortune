import test from 'node:test';
import assert from 'node:assert/strict';
import { isLowEndDevice, LOW_END_FIRST_RENDER } from './deviceTier.js';

// Why this is a module and not two lines inside the component:
//
// The wheel drops its SVG filters and SMIL animation on weak phones. That
// decision used to be taken during the very first render, from `navigator`.
// Node 21+ ships a global `navigator` WITH hardwareConcurrency, so on Vercel
// the server answered the question itself — and answered "low end", shipping
// the 18-light tree. Every visitor whose phone reports more than 4 cores then
// rendered the 36-light tree on hydration, React found a different DOM, and
// threw the whole root away to re-render on the client (#418/#423). Until that
// finished the SPIN button on screen was inert server HTML and taps were lost.
//
// So: the first render is a FIXED tree on both sides, and the device tier is
// only consulted after mount.

test('the first render never depends on the device', () => {
  assert.equal(LOW_END_FIRST_RENDER, true);
});

test('weak phones are low end', () => {
  assert.equal(isLowEndDevice({ hardwareConcurrency: 4, deviceMemory: 4 }), true);
  assert.equal(isLowEndDevice({ hardwareConcurrency: 8, deviceMemory: 2 }), true);
  assert.equal(isLowEndDevice({ hardwareConcurrency: 2 }), true);
});

test('capable phones and desktops are not', () => {
  assert.equal(isLowEndDevice({ hardwareConcurrency: 8, deviceMemory: 8 }), false);
  assert.equal(isLowEndDevice({ hardwareConcurrency: 6, deviceMemory: 4 }), false);
});

test('missing fields are treated as capable, as the old inline check did', () => {
  // Safari/Firefox report no deviceMemory; that alone must not demote them.
  assert.equal(isLowEndDevice({ hardwareConcurrency: 8 }), false);
  assert.equal(isLowEndDevice({}), false);
});

test('no navigator at all stays on the cheap tree', () => {
  assert.equal(isLowEndDevice(null), true);
  assert.equal(isLowEndDevice(undefined), true);
});
