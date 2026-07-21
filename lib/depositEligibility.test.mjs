import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasQualifyingDeposit } from './depositEligibility.js';

// Window: prior wheel-day = [2026-07-20T04:00Z, 2026-07-21T04:00Z)
const WIN = {
  prevStartMs: Date.parse('2026-07-20T04:00:00Z'),
  curStartMs: Date.parse('2026-07-21T04:00:00Z'),
};
const rec = (over) => ({ op_type: 'IN-KZ-AIRTEL', status: 'SUCCESS', created_at: '2026-07-20T10:00:00.000Z', ...over });

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
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-20T03:59:59.000Z' })], WIN), false);
});

test('deposit at curStart (exclusive upper bound) does not qualify', () => {
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-21T04:00:00.000Z' })], WIN), false);
});

test('deposit at prevStart (inclusive lower bound) qualifies', () => {
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-20T04:00:00.000Z' })], WIN), true);
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
