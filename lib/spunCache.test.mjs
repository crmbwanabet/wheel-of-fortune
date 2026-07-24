import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasSpun, withSpun } from './spunCache.mjs';

const DAY = '2026-07-24';
const PREV = '2026-07-23';

test('hasSpun: false when no stored value', () => {
  assert.equal(hasSpun(null, '207978', DAY), false);
  assert.equal(hasSpun('', '207978', DAY), false);
});

test('hasSpun: false without a customerId', () => {
  const raw = withSpun(null, '207978', DAY);
  assert.equal(hasSpun(raw, null, DAY), false);
  assert.equal(hasSpun(raw, '', DAY), false);
});

test('hasSpun: true only for the same account + same day', () => {
  const raw = withSpun(null, '207978', DAY);
  assert.equal(hasSpun(raw, '207978', DAY), true);
  assert.equal(hasSpun(raw, '169', DAY), false);
  assert.equal(hasSpun(raw, '207978', PREV), false);
});

test('withSpun: two accounts on one device are independent', () => {
  let raw = withSpun(null, '207978', DAY);
  raw = withSpun(raw, '169', DAY);
  assert.equal(hasSpun(raw, '207978', DAY), true);
  assert.equal(hasSpun(raw, '169', DAY), true);
});

test('withSpun: prunes entries from previous days', () => {
  const stale = JSON.stringify({ '111': PREV, '222': PREV });
  const raw = withSpun(stale, '207978', DAY);
  const map = JSON.parse(raw);
  assert.deepEqual(Object.keys(map).sort(), ['207978']);
  assert.equal(map['207978'], DAY);
});

test('withSpun: tolerates corrupt JSON', () => {
  const raw = withSpun('not-json{', '207978', DAY);
  assert.equal(hasSpun(raw, '207978', DAY), true);
});

test('hasSpun: tolerates corrupt JSON', () => {
  assert.equal(hasSpun('not-json{', '207978', DAY), false);
});
