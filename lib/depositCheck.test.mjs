import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDepositEligibility } from './depositCheck.js';

const NOW = Date.parse('2026-07-21T12:00:00Z'); // window: [2026-07-20T04:00Z, 2026-07-21T04:00Z)
const IN_WINDOW = '2026-07-20T10:00:00.000Z';

// A fake fetch returning a Response-like object with the given json + status.
const fakeFetch = (json, { status = 200, delayMs = 0 } = {}) => () =>
  new Promise((resolve) =>
    setTimeout(() => resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    }), delayMs));

const okBody = (records) => ({ error: false, message: 'Success', data: records });

test('timely qualifying deposit -> eligible / deposit_found', async () => {
  const { sync, completion } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 1000,
    fetchImpl: fakeFetch(okBody([{ op_type: 'IN-KZ-AIRTEL', status: 'SUCCESS', created_at: IN_WINDOW }])),
  });
  assert.equal(sync.eligible, true);
  assert.equal(sync.reason, 'deposit_found');
  const eventual = await completion;
  assert.equal(eventual.eligible, true);
  assert.equal(eventual.reason, 'deposit_found');
});

test('timely with only a withdrawal -> ineligible / no_deposit', async () => {
  const { sync } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 1000,
    fetchImpl: fakeFetch(okBody([{ op_type: 'OUT-KZ-AIRTEL', status: 'SUCCESS', created_at: IN_WINDOW }])),
  });
  assert.equal(sync.eligible, false);
  assert.equal(sync.reason, 'no_deposit');
});

test('non-200 -> fail-closed error', async () => {
  const { sync } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 1000, fetchImpl: fakeFetch(null, { status: 500 }),
  });
  assert.equal(sync.eligible, false);
  assert.equal(sync.reason, 'error');
});

test('api-level error:true -> fail-closed error', async () => {
  const { sync } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 1000, fetchImpl: fakeFetch({ error: true, message: 'nope', data: null }),
  });
  assert.equal(sync.eligible, false);
  assert.equal(sync.reason, 'error');
});

test('thrown network error -> fail-closed error', async () => {
  const { sync } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 1000,
    fetchImpl: () => Promise.reject(new Error('boom')),
  });
  assert.equal(sync.eligible, false);
  assert.equal(sync.reason, 'error');
});

test('slow call -> sync times out (fail-closed) but completion still resolves the real answer', async () => {
  const { sync, completion } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 20, bgCapMs: 1000,
    fetchImpl: fakeFetch(okBody([{ op_type: 'IN-KZ-AIRTEL', status: 'SUCCESS', created_at: IN_WINDOW }]), { delayMs: 100 }),
  });
  assert.equal(sync.eligible, false);
  assert.equal(sync.reason, 'timeout');
  const eventual = await completion;          // the late result must still arrive
  assert.equal(eventual.eligible, true);
  assert.equal(eventual.reason, 'deposit_found');
  assert.equal(Number.isFinite(eventual.latencyMs), true);
});

test('malformed / non-JSON body -> fail-closed error', async () => {
  // 200 OK, but res.json() rejects (garbage body).
  const badJsonFetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: async () => { throw new Error('Unexpected token < in JSON'); },
  });
  const { sync } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 1000, fetchImpl: badJsonFetch,
  });
  assert.equal(sync.eligible, false);
  assert.equal(sync.reason, 'error');
});

test('call exceeding bgCap is aborted -> fail-closed error', async () => {
  // fetch honours the abort signal; with bgCapMs tiny and the call slow, the
  // controller aborts -> rejection -> error verdict.
  const abortableSlowFetch = (_url, opts) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: true, status: 200, json: async () => okBody([]) }), 500);
    opts.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });
  const { sync, completion } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 10, bgCapMs: 20, fetchImpl: abortableSlowFetch,
  });
  assert.equal(sync.reason, 'timeout');       // sync gives up first (fail-closed)
  const eventual = await completion;          // background call is aborted by bgCap
  assert.equal(eventual.eligible, false);
  assert.equal(eventual.reason, 'error');
});
