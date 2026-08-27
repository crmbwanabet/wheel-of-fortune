import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ATTEMPTS, RETRY_COOLDOWN_MS, SEND_SPACING_MS, SWEEP_BATCH, sweepEligible,
} from './notifyOutbox.js';

const NOW = Date.parse('2026-08-27T12:00:00Z');

test('fresh pending rows are eligible', () => {
  assert.equal(sweepEligible({ status: 'pending', attempts: 0, last_attempt_at: null }, NOW), true);
});

test('sent, failed, and exhausted rows are not eligible', () => {
  assert.equal(sweepEligible({ status: 'sent', attempts: 1 }, NOW), false);
  assert.equal(sweepEligible({ status: 'failed', attempts: 12 }, NOW), false);
  assert.equal(sweepEligible({ status: 'pending', attempts: MAX_ATTEMPTS }, NOW), false);
});

test('a recent attempt cools down before the next retry', () => {
  const recent = new Date(NOW - RETRY_COOLDOWN_MS / 2).toISOString();
  const old = new Date(NOW - RETRY_COOLDOWN_MS - 1000).toISOString();
  assert.equal(sweepEligible({ status: 'pending', attempts: 1, last_attempt_at: recent }, NOW), false);
  assert.equal(sweepEligible({ status: 'pending', attempts: 1, last_attempt_at: old }, NOW), true);
});

test('garbage rows and timestamps fail safe', () => {
  assert.equal(sweepEligible(null, NOW), false);
  assert.equal(sweepEligible({ status: 'pending', attempts: 0, last_attempt_at: 'garbage' }, NOW), true);
});

test('sweep pacing stays under Telegram group limits', () => {
  // ~1 msg / 1.2s, batch bounded so a run fits the function window.
  assert.ok(SEND_SPACING_MS >= 1100);
  assert.ok(SWEEP_BATCH * SEND_SPACING_MS <= 25000);
});
