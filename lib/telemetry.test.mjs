import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportError, errorSignature, _resetTelemetry, _setErrorSink } from './telemetry.js';

// No TELEGRAM_ALERT_CHAT_ID / BOT_TOKEN in the test env, so sendTelegram is a
// no-op and reportError returns the alert text it WOULD have sent (or null).

test('errorSignature combines route and code/status', () => {
  assert.equal(errorSignature({ route: 'spin', status: 500 }), 'spin:500');
  assert.equal(errorSignature({ route: 'spin', code: 'db_error' }), 'spin:db_error');
  assert.equal(errorSignature({}), 'unknown:error');
});

test('first occurrence of a signature alerts immediately', async () => {
  _resetTelemetry();
  const t = await reportError(new Error('boom'), { route: 'spin', status: 500 }, 1000);
  assert.ok(t && t.includes('spin:500'));
  assert.ok(t.includes('boom'));
});

test('repeats within the window are counted silently, not re-sent', async () => {
  _resetTelemetry();
  await reportError(new Error('boom'), { route: 'spin', status: 500 }, 1000);
  const second = await reportError(new Error('boom'), { route: 'spin', status: 500 }, 2000);
  assert.equal(second, null); // suppressed (counting)
});

test('after the window elapses, a rollup with the count is sent', async () => {
  _resetTelemetry();
  await reportError(new Error('boom'), { route: 'spin', status: 500 }, 1000);
  await reportError(new Error('boom'), { route: 'spin', status: 500 }, 2000);
  await reportError(new Error('boom'), { route: 'spin', status: 500 }, 3000);
  // window = 5 min; jump past it
  const rollup = await reportError(new Error('boom'), { route: 'spin', status: 500 }, 1000 + 6 * 60 * 1000);
  assert.ok(rollup && /×|x/i.test(rollup)); // contains a count
  assert.ok(rollup.includes('spin:500'));
});

test('global rate cap suppresses beyond MAX_ALERTS_PER_MIN distinct signatures', async () => {
  _resetTelemetry();
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(await reportError(new Error('e' + i), { route: 'r' + i, status: 500 }, 1000 + i));
  }
  const sent = results.filter(Boolean).length;
  assert.ok(sent <= 6, `expected <=6 sent, got ${sent}`);
});

test('health signal fires when 5xx rate crosses threshold', async () => {
  _resetTelemetry();
  let health = null;
  for (let i = 0; i < 25; i++) {
    const t = await reportError(new Error('busy'), { route: 'spin', status: 503 }, 1000 + i * 100);
    if (t && t.includes('Elevated errors')) health = t;
  }
  assert.ok(health, 'expected a health-signal alert');
});

test('reportError never throws on a bad error object', async () => {
  _resetTelemetry();
  await assert.doesNotReject(() => reportError(null, { route: 'spin' }, 1000));
});

test('a dispatched alert is persisted with signature, code, customer, and message', async () => {
  _resetTelemetry();
  const rows = [];
  _setErrorSink(async (r) => { rows.push(r); });
  await reportError(new Error('boom'), { route: 'spin', status: 500, code: 'claim_failed', customerId: '42' }, 1000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].signature, 'spin:claim_failed');
  assert.equal(rows[0].route, 'spin');
  assert.equal(rows[0].code, 'claim_failed');
  assert.equal(rows[0].status, 500);
  assert.equal(rows[0].customer_id, '42');
  assert.equal(rows[0].occurrences, 1);
  assert.ok(rows[0].message.includes('boom'));
});

test('counted repeats are not persisted; the rollup persists with the total count', async () => {
  _resetTelemetry();
  const rows = [];
  _setErrorSink(async (r) => { rows.push(r); });
  await reportError(new Error('boom'), { route: 'spin', status: 500 }, 1000);                 // dispatched → persisted
  await reportError(new Error('boom'), { route: 'spin', status: 500 }, 2000);                 // counted, silent
  await reportError(new Error('boom'), { route: 'spin', status: 500 }, 3000);                 // counted, silent
  await reportError(new Error('boom'), { route: 'spin', status: 500 }, 1000 + 6 * 60 * 1000); // rollup → persisted
  assert.equal(rows.length, 2);
  assert.equal(rows[0].occurrences, 1);
  assert.equal(rows[1].occurrences, 4);
});

test('a persistence failure never breaks alerting', async () => {
  _resetTelemetry();
  _setErrorSink(async () => { throw new Error('db down'); });
  const t = await reportError(new Error('boom'), { route: 'spin', status: 500 }, 1000);
  assert.ok(t && t.includes('spin:500')); // alert still returned despite sink throwing
});

// A widget report carries the page it fired on. Without it, a report from a
// developer's own machine is indistinguishable in the log from a real customer
// failure on bwanabet.com — three reports were misread that way on 2026-08-06/07.
test('a dispatched alert persists the host page the report came from', async () => {
  _resetTelemetry();
  const rows = [];
  _setErrorSink(async (r) => { rows.push(r); });
  await reportError(new Error('cause=no_ready_after_load'),
    { route: 'widget', code: 'widget_never_ready', source: 'widget', host: 'www.bwanabet.com' }, 1000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].host, 'www.bwanabet.com');
});

test('the alert text names the host page', async () => {
  _resetTelemetry();
  const t = await reportError(new Error('cause=no_ready_after_load'),
    { route: 'widget', code: 'widget_never_ready', host: 'localhost:3000' }, 1000);
  assert.ok(t && t.includes('localhost:3000'), `host missing from alert: ${t}`);
});

test('a report with no host recorded persists null rather than a placeholder', async () => {
  _resetTelemetry();
  const rows = [];
  _setErrorSink(async (r) => { rows.push(r); });
  await reportError(new Error('boom'), { route: 'spin', status: 500 }, 1000);
  assert.equal(rows[0].host, null);
});
