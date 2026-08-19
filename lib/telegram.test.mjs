import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catTimestamp, formatWinMessage } from './telegram.js';

test('catTimestamp renders CAT (UTC+2), not UTC', () => {
  // 06:47 UTC on 2026-07-25 is 08:47 CAT.
  const utc = Date.parse('2026-07-25T06:47:00Z');
  assert.equal(catTimestamp(utc), '2026-07-25 08:47:00 CAT');
});

test('catTimestamp rolls the date across the UTC→CAT midnight boundary', () => {
  // 23:30 UTC → 01:30 next-day CAT.
  const utc = Date.parse('2026-07-25T23:30:00Z');
  assert.equal(catTimestamp(utc), '2026-07-26 01:30:00 CAT');
});

test('formatWinMessage includes the spin position out of 10000', () => {
  const msg = formatWinMessage({ customerId: '207978', prizeAmount: 50, winsToday: 3, budgetSpent: 270, spinNumber: 2567 });
  assert.ok(msg.includes('🎡 Spin: 2567/10000'), msg);
  assert.ok(msg.includes('K50'));
  assert.ok(msg.includes('207978'));
  assert.ok(msg.includes('3/250 wins'), msg);
});

test('formatWinMessage in queue mode shows win ordinal of the pool size, not spin position', () => {
  const msg = formatWinMessage({
    customerId: '207978', prizeAmount: 50, winsToday: 3, budgetSpent: 270,
    spinNumber: 2567, payoutMode: 'queue',
  });
  assert.ok(msg.includes('Win #3 of 250'), msg);
  assert.ok(!msg.includes('/10000'));
});

test('queue mode shows the win ordinal out of an explicit pool size', () => {
  const msg = formatWinMessage({
    customerId: '172436', prizeAmount: 5, winsToday: 55,
    budgetSpent: 400, spinNumber: 104, payoutMode: 'queue', poolSize: 250,
  });
  assert.ok(msg.includes('Win #55 of 250'), msg);
  assert.ok(msg.includes('55/250 wins'), msg);
});

test('pool size falls back to 250 when not supplied', () => {
  const msg = formatWinMessage({
    customerId: '1', prizeAmount: 5, winsToday: 1,
    budgetSpent: 5, spinNumber: 1, payoutMode: 'queue',
  });
  assert.ok(msg.includes('of 250'), msg);
});
