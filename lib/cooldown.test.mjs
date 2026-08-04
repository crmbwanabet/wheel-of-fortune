import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COOLDOWN_DAYS,
  resolveCooldownDays,
  shiftWheelDay,
  cooldownWindow,
  blocksSpin,
} from './cooldown.js';

// Rule: won on wheel-day D -> cannot win on D+1, D+2, D+3 -> winnable again D+4.

test('default cooldown is 3 days', () => {
  assert.equal(DEFAULT_COOLDOWN_DAYS, 3);
});

test('a win blocks the next three wheel-days', () => {
  const won = '2026-08-03';
  assert.equal(blocksSpin(won, '2026-08-04', 3), true);  // D+1
  assert.equal(blocksSpin(won, '2026-08-05', 3), true);  // D+2
  assert.equal(blocksSpin(won, '2026-08-06', 3), true);  // D+3
  assert.equal(blocksSpin(won, '2026-08-07', 3), false); // D+4 — winnable
});

test('a win does not block the day it happened (daily dedupe covers that)', () => {
  assert.equal(blocksSpin('2026-08-03', '2026-08-03', 3), false);
});

test('an older win does not block', () => {
  assert.equal(blocksSpin('2026-07-01', '2026-08-04', 3), false);
});

test('window spans a month boundary', () => {
  const won = '2026-07-31';
  assert.equal(blocksSpin(won, '2026-08-01', 3), true);
  assert.equal(blocksSpin(won, '2026-08-03', 3), true);
  assert.equal(blocksSpin(won, '2026-08-04', 3), false);
});

test('window spans a year boundary', () => {
  const won = '2025-12-31';
  assert.equal(blocksSpin(won, '2026-01-01', 3), true);
  assert.equal(blocksSpin(won, '2026-01-03', 3), true);
  assert.equal(blocksSpin(won, '2026-01-04', 3), false);
});

test('cooldown of 0 disables the rule entirely', () => {
  assert.equal(cooldownWindow('2026-08-04', 0), null);
  assert.equal(blocksSpin('2026-08-03', '2026-08-04', 0), false);
});

test('cooldownWindow returns the inclusive blocking range', () => {
  assert.deepEqual(cooldownWindow('2026-08-04', 3), { from: '2026-08-01', to: '2026-08-03' });
});

test('shiftWheelDay moves days in UTC across boundaries', () => {
  assert.equal(shiftWheelDay('2026-08-04', -1), '2026-08-03');
  assert.equal(shiftWheelDay('2026-08-01', -1), '2026-07-31');
  assert.equal(shiftWheelDay('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftWheelDay('2026-02-28', 1), '2026-03-01'); // 2026 is not a leap year
});

test('resolveCooldownDays falls back to the default on junk', () => {
  assert.equal(resolveCooldownDays(undefined), 3);
  assert.equal(resolveCooldownDays(null), 3);
  assert.equal(resolveCooldownDays(''), 3);
  assert.equal(resolveCooldownDays('abc'), 3);
  assert.equal(resolveCooldownDays('-1'), 3);
  assert.equal(resolveCooldownDays('2.5'), 3);
});

test('resolveCooldownDays honours valid values including the 0 kill-switch', () => {
  assert.equal(resolveCooldownDays('5'), 5);
  assert.equal(resolveCooldownDays('0'), 0);
  assert.equal(resolveCooldownDays(7), 7);
});
