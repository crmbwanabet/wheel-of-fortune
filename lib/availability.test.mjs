import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAvailability } from './availability.mjs';

// Only a genuine "you already spun today" may be written to the per-account
// localStorage cache. Every other unavailable verdict is transient and MUST NOT
// suppress the wheel for the rest of the wheel-day.

test('a spin is available -> shown, not sticky', () => {
  const v = decideAvailability({ status: 200, body: { available: true, reason: 'available' } });
  assert.deepEqual(v, { available: true, sticky: false, reason: 'available' });
});

test('already spun -> hidden AND sticky', () => {
  const v = decideAvailability({ status: 200, body: { available: false, reason: 'already_spun' } });
  assert.deepEqual(v, { available: false, sticky: true, reason: 'already_spun' });
});

test('a sticky-looking reason on a non-200 is NOT sticky', () => {
  assert.deepEqual(decideAvailability({ status: 500, body: { available: false, reason: 'already_spun' } }),
    { available: false, sticky: false, reason: 'already_spun' });
});

test('maintenance -> hidden but NOT sticky', () => {
  const v = decideAvailability({ status: 200, body: { available: false, maintenance: true, reason: 'maintenance' } });
  assert.deepEqual(v, { available: false, sticky: false, reason: 'maintenance' });
});

test('expired token -> hidden but NOT sticky', () => {
  const v = decideAvailability({ status: 401, body: { available: false, error: 'token_expired', reason: 'token_expired' } });
  assert.deepEqual(v, { available: false, sticky: false, reason: 'token_expired' });
});

test('invalid token -> hidden but NOT sticky', () => {
  const v = decideAvailability({ status: 401, body: { available: false, error: 'invalid_token', reason: 'invalid_token' } });
  assert.deepEqual(v, { available: false, sticky: false, reason: 'invalid_token' });
});

test('a 401 with neither reason nor error falls back to unauthenticated', () => {
  assert.deepEqual(decideAvailability({ status: 401, body: { available: false } }),
    { available: false, sticky: false, reason: 'unauthenticated' });
});

test('unavailable with no reason (old deploy) -> hidden but NOT sticky', () => {
  assert.deepEqual(decideAvailability({ status: 200, body: { available: false } }),
    { available: false, sticky: false, reason: 'unknown' });
});

test('unreadable body -> fails OPEN, never sticky', () => {
  const v = decideAvailability({ status: 500, body: null });
  assert.deepEqual(v, { available: true, sticky: false, reason: 'unreadable' });
});

test('401 whose body did not parse -> still fails OPEN', () => {
  assert.deepEqual(decideAvailability({ status: 401, body: null }),
    { available: true, sticky: false, reason: 'unreadable' });
});

test('an array body is unreadable, not available', () => {
  assert.deepEqual(decideAvailability({ status: 200, body: [] }),
    { available: true, sticky: false, reason: 'unreadable' });
});

test('server fail-open response is available and not sticky', () => {
  assert.deepEqual(decideAvailability({ status: 200, body: { available: true, reason: 'check_failed' } }),
    { available: true, sticky: false, reason: 'check_failed' });
});
