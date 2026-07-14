import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportError, errorSignature, _resetTelemetry } from './telemetry.js';

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
