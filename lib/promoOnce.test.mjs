import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMO_STORAGE_KEY, readPromoSpun, writePromoSpun } from './promoOnce.js';

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
}

test('fresh storage → not spun', () => {
  assert.equal(readPromoSpun(memStorage()), null);
});

test('write then read round-trips the timestamp', () => {
  const s = memStorage();
  writePromoSpun(s, '2026-08-21T10:00:00.000Z');
  assert.equal(readPromoSpun(s), '2026-08-21T10:00:00.000Z');
  assert.ok(s._m.has(PROMO_STORAGE_KEY));
});

test('corrupt or foreign values read as not spun', () => {
  assert.equal(readPromoSpun(memStorage({ [PROMO_STORAGE_KEY]: 'garbage' })), null);
  assert.equal(readPromoSpun(memStorage({ [PROMO_STORAGE_KEY]: '{"spunAt":42}' })), null);
});

test('a storage that throws is tolerated', () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readPromoSpun(bad), null);
  assert.doesNotThrow(() => writePromoSpun(bad, '2026-08-21T10:00:00.000Z'));
});

test('missing storage (SSR) is tolerated', () => {
  assert.equal(readPromoSpun(null), null);
  assert.doesNotThrow(() => writePromoSpun(undefined, '2026-08-21T10:00:00.000Z'));
});
