import test from 'node:test';
import assert from 'node:assert/strict';
import { EARLY_TAP_ATTR, EARLY_TAP_FLAG, EARLY_TAP_SCRIPT, takeQueuedTap } from './earlyTap.js';

// The promo page is server-rendered, so the SPIN button is painted — pulsing,
// captioned, and to every appearance live — as soon as the HTML lands, but it
// does nothing until the bundle has downloaded, parsed and hydrated. Measured
// on a throttled phone that gap is 3.2-3.8s, and every tap inside it is
// discarded in silence: the player taps SPIN, the wheel sits still, and they
// leave believing it is broken. This module keeps that first tap.

test('a queued tap is handed over exactly once', () => {
  const win = { [EARLY_TAP_FLAG]: 1 };
  assert.equal(takeQueuedTap(win), true);
  assert.equal(takeQueuedTap(win), false, 'a replayed tap must not spin twice');
});

test('no tap queued means nothing to replay', () => {
  assert.equal(takeQueuedTap({}), false);
  assert.equal(takeQueuedTap(null), false);
  assert.equal(takeQueuedTap(undefined), false);
});

// The listener ships as a string of source and the reader lives in JS: nothing
// but this test stops the two drifting apart when a name is changed.
test('the inline listener and the reader agree on the flag and the hook', () => {
  assert.ok(EARLY_TAP_SCRIPT.includes(EARLY_TAP_FLAG),
    'the script must set the same flag takeQueuedTap reads');
  assert.ok(EARLY_TAP_SCRIPT.includes(EARLY_TAP_ATTR),
    'the script must look for the same attribute the buttons carry');
});

test('the listener is inert markup — no quote can break out of the tag', () => {
  assert.ok(!EARLY_TAP_SCRIPT.includes('</script'), 'must not close its own tag');
});
