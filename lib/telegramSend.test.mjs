import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendTelegram } from './telegramSend.js';

const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
const httpFailFetch = async () => ({ ok: false, status: 403, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }) });
const apiFailFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) });
const throwFetch = async () => { throw new Error('ECONNRESET'); };

function capture() {
  const rows = [];
  return { rows, sink: async (row) => { rows.push(row); } };
}

test('returns true and writes nothing when Telegram accepts', async () => {
  const c = capture();
  const ok = await sendTelegram({ token: 't', chatId: '1', text: 'hi', fetchImpl: okFetch, sink: c.sink });
  assert.equal(ok, true);
  assert.equal(c.rows.length, 0);
});

test('HTTP failure → false + one telegram_send_failed row with the description', async () => {
  const c = capture();
  const ok = await sendTelegram({ token: 't', chatId: '1', text: 'lost alert text', fetchImpl: httpFailFetch, sink: c.sink });
  assert.equal(ok, false);
  assert.equal(c.rows.length, 1);
  assert.equal(c.rows[0].code, 'telegram_send_failed');
  assert.equal(c.rows[0].signature, 'telegram:telegram_send_failed');
  assert.equal(c.rows[0].status, 403);
  assert.match(c.rows[0].message, /blocked by the user/);
  assert.match(c.rows[0].message, /lost alert text/);
});

test('{ok:false} body → false + row even when HTTP 200', async () => {
  const c = capture();
  const ok = await sendTelegram({ token: 't', chatId: '1', text: 'x', fetchImpl: apiFailFetch, sink: c.sink });
  assert.equal(ok, false);
  assert.match(c.rows[0].message, /chat not found/);
});

test('network throw → false + row, never throws', async () => {
  const c = capture();
  const ok = await sendTelegram({ token: 't', chatId: '1', text: 'x', fetchImpl: throwFetch, sink: c.sink });
  assert.equal(ok, false);
  assert.match(c.rows[0].message, /ECONNRESET/);
});

test('missing config → false, no row, no fetch', async () => {
  const c = capture();
  let called = false;
  const ok = await sendTelegram({ token: '', chatId: '', text: 'x', fetchImpl: async () => { called = true; }, sink: c.sink });
  assert.equal(ok, false);
  assert.equal(called, false);
  assert.equal(c.rows.length, 0);
});

test('a failing sink is swallowed', async () => {
  const ok = await sendTelegram({ token: 't', chatId: '1', text: 'x', fetchImpl: throwFetch, sink: async () => { throw new Error('db down'); } });
  assert.equal(ok, false);
});
