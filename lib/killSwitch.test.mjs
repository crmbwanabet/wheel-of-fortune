import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWinsDisabled, shouldRunDepositGate } from './killSwitch.js';

// An operator-flippable switch that stops ALL payouts within one spin, without
// a redeploy and without taking the wheel down. Customers keep spinning and
// land on "Try Again Tomorrow" — the same loss path that already runs in
// production, so there is no new UX to break.
//
// Born from 2026-08-14: flipping the payout mode mid-day drained K1,710 in ten
// minutes, and the only way to stop it was hand-written SQL against
// wheel_daily_state. That worked but was destructive (it wiped the day's
// winning-position map) and could not be undone.

test('the switch is off by default — a fresh install pays normally', () => {
  assert.equal(resolveWinsDisabled({ wins_disabled: false }, null), false);
});

test('the switch stops wins when set', () => {
  assert.equal(resolveWinsDisabled({ wins_disabled: true }, null), true);
});

// FAIL OPEN, deliberately. A killswitch that engages itself on a DB hiccup
// would silently stop every payout with no operator action and no alert — the
// failure would look exactly like "nobody is winning today". A read error must
// leave the wheel behaving as it already was.
test('a read error leaves wins enabled rather than silently killing payouts', () => {
  assert.equal(resolveWinsDisabled(null, new Error('connection reset')), false);
});

test('a missing controls row leaves wins enabled', () => {
  assert.equal(resolveWinsDisabled(null, null), false);
  assert.equal(resolveWinsDisabled(undefined, null), false);
});

test('a malformed row leaves wins enabled', () => {
  for (const bad of [{}, { wins_disabled: null }, { wins_disabled: 'yes' }, 'nope', 42, []]) {
    assert.equal(resolveWinsDisabled(bad, null), false, `for ${JSON.stringify(bad)}`);
  }
});

// Only a real boolean true engages it. Anything else is treated as "not set".
test('only boolean true engages the switch', () => {
  assert.equal(resolveWinsDisabled({ wins_disabled: 1 }, null), false);
  assert.equal(resolveWinsDisabled({ wins_disabled: 'true' }, null), false);
  assert.equal(resolveWinsDisabled({ wins_disabled: true }, null), true);
});

// With payouts off there is nothing for the gate to decide, and every check is
// a paid round-trip to BwanaBet on the spin's hot path. Skipping it makes the
// switch shed load at exactly the moment something is going wrong.
test('the deposit gate is skipped entirely while wins are disabled', () => {
  assert.equal(shouldRunDepositGate({ isTest: false, winsDisabled: true, mode: 'enforce' }), false);
  assert.equal(shouldRunDepositGate({ isTest: false, winsDisabled: true, mode: 'shadow' }), false);
});

test('the gate runs as normal while wins are enabled', () => {
  assert.equal(shouldRunDepositGate({ isTest: false, winsDisabled: false, mode: 'enforce' }), true);
  assert.equal(shouldRunDepositGate({ isTest: false, winsDisabled: false, mode: 'shadow' }), true);
});

test('gate stays off for modes that never ran it, and for test traffic', () => {
  assert.equal(shouldRunDepositGate({ isTest: false, winsDisabled: false, mode: 'off' }), false);
  assert.equal(shouldRunDepositGate({ isTest: true, winsDisabled: false, mode: 'enforce' }), false);
});
