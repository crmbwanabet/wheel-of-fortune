import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasQualifyingDeposit } from './depositEligibility.js';

// Window: last 7 wheel-days + today-so-far = [2026-07-14T04:00Z, 2026-07-21T12:00Z]
// (inclusive upper bound — the bound is the spin moment itself).
const WIN = {
  startMs: Date.parse('2026-07-14T04:00:00Z'),
  endMs: Date.parse('2026-07-21T12:00:00Z'),
};
const rec = (over) => ({ op_type: 'IN-KZ-AIRTEL', status: 'SUCCESS', created_at: '2026-07-16T10:00:00.000Z', ...over });

test('successful IN deposit inside the window qualifies', () => {
  assert.equal(hasQualifyingDeposit([rec()], WIN), true);
});

test('withdrawal (OUT) does not qualify', () => {
  assert.equal(hasQualifyingDeposit([rec({ op_type: 'OUT-KZ-AIRTEL' })], WIN), false);
});

test('non-SUCCESS deposit does not qualify', () => {
  assert.equal(hasQualifyingDeposit([rec({ status: 'PENDING' })], WIN), false);
});

test('deposit before the window start does not qualify', () => {
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-14T03:59:59.000Z' })], WIN), false);
});

test('deposit at startMs (inclusive lower bound) qualifies', () => {
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-14T04:00:00.000Z' })], WIN), true);
});

test('deposit exactly at endMs (inclusive upper bound = spin moment) qualifies', () => {
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-21T12:00:00.000Z' })], WIN), true);
});

test('deposit after endMs does not qualify', () => {
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-21T12:00:01.000Z' })], WIN), false);
});

test('deposit made earlier today (same wheel-day as the spin) qualifies', () => {
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-21T09:00:00.000Z' })], WIN), true);
});

test('empty / non-array / garbage input does not qualify', () => {
  assert.equal(hasQualifyingDeposit([], WIN), false);
  assert.equal(hasQualifyingDeposit(null, WIN), false);
  assert.equal(hasQualifyingDeposit([{}, { op_type: 'IN-X', status: 'SUCCESS', created_at: 'not-a-date' }], WIN), false);
});

test('mixed list qualifies if ANY record qualifies', () => {
  const data = [rec({ op_type: 'OUT-KZ-AIRTEL' }), rec({ created_at: '2026-07-20T23:00:00.000Z' })];
  assert.equal(hasQualifyingDeposit(data, WIN), true);
});
