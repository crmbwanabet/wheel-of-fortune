import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lossesLine, winsSeenLine, potExhausted, LOSS_REASONS } from './digestLines.js';

test('LOSS_REASONS is the fixed ordered vocabulary', () => {
  assert.deepEqual(LOSS_REASONS, ['cap_reached', 'pot_empty', 'queue_null', 'cooldown', 'ineligible', 'random']);
});

test('lossesLine lists non-zero reasons in order, omits zeros', () => {
  assert.equal(
    lossesLine({ cap_reached: 166, cooldown: 14, ineligible: 170, random: 0 }),
    'Losses: cap_reached 166 · cooldown 14 · ineligible 170',
  );
});

test('lossesLine returns null when nothing to say', () => {
  assert.equal(lossesLine({}), null);
  assert.equal(lossesLine({ random: 0 }), null);
});

test('lossesLine ignores unknown keys', () => {
  assert.equal(lossesLine({ bogus: 5, pot_empty: 1 }), 'Losses: pot_empty 1');
});

test('winsSeenLine shows seen/total and flags a low ratio', () => {
  assert.equal(winsSeenLine(18, 20), 'Wins seen: 18 / 20');
  assert.equal(winsSeenLine(9, 20), 'Wins seen: 9 / 20 ⚠️ below 75%');
  assert.equal(winsSeenLine(0, 0), null);
});

test('potExhausted is true at POOL_SIZE wins, not before', () => {
  assert.equal(potExhausted(199, 200), false);
  assert.equal(potExhausted(200, 200), true);
  assert.equal(potExhausted(null, 200), false);
});

test('promoLine formats the funnel for one host and hides an idle host', async () => {
  const { promoLine } = await import('./digestLines.js');
  assert.equal(promoLine('spin.example.com', { view: 412, spin: 380, claim_click: 291 }),
    'Promo spin.example.com: 412 views · 380 spins · 291 claims');
  assert.equal(promoLine('spin.example.com', { view: 0, spin: 0, claim_click: 0 }), null);
  assert.equal(promoLine('spin.example.com', {}), null);
});
