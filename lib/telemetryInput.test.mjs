import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomerId } from './telemetryInput.js';

// /api/telemetry is public and unauthenticated: anything here is a reporting
// hint, never an authorisation input. It still must not let arbitrary text into
// wheel_error_log.customer_id, which is read back when tracing lost spins.

test('accepts a numeric customer id as a string', () => {
  assert.equal(parseCustomerId('207978'), '207978');
});

test('accepts a numeric customer id as a number', () => {
  assert.equal(parseCustomerId(207978), '207978');
});

test('rejects anything non-numeric', () => {
  assert.equal(parseCustomerId('abc'), undefined);
  assert.equal(parseCustomerId('207978; DROP TABLE'), undefined);
  assert.equal(parseCustomerId('../../etc/passwd'), undefined);
  assert.equal(parseCustomerId('207978 '), undefined);
  assert.equal(parseCustomerId('-1'), undefined);
  assert.equal(parseCustomerId('1.5'), undefined);
});

test('rejects absent and empty values', () => {
  assert.equal(parseCustomerId(undefined), undefined);
  assert.equal(parseCustomerId(null), undefined);
  assert.equal(parseCustomerId(''), undefined);
});

test('rejects objects and arrays rather than stringifying them', () => {
  // JSON.parse of a hostile body can hand us any shape. "[object Object]" in
  // the customer column would be worse than nothing.
  assert.equal(parseCustomerId({}), undefined);
  assert.equal(parseCustomerId(['207978']), undefined);
  assert.equal(parseCustomerId(true), undefined);
});

test('rejects an absurdly long digit string', () => {
  // Bounded so the column cannot be used as a dumping ground.
  assert.equal(parseCustomerId('1'.repeat(21)), undefined);
  assert.equal(parseCustomerId('1'.repeat(20)), '1'.repeat(20));
});
