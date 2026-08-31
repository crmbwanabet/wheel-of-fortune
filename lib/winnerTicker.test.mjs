import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TICKER_NAMES, TICKER_SURNAMES, TICKER_TOWNS, TICKER_PRIZES, JACKPOT_PRIZE,
  TICKER_INTERVAL_MS, nextWinner, nextDelayMs,
} from './winnerTicker.js';

test('pools are large enough to feel varied (owner floor: 250 names)', () => {
  assert.ok(TICKER_NAMES.length >= 250, `only ${TICKER_NAMES.length} names`);
  assert.ok(new Set(TICKER_NAMES).size === TICKER_NAMES.length);
  assert.ok(TICKER_SURNAMES.length >= 30);
  assert.ok(new Set(TICKER_SURNAMES).size === TICKER_SURNAMES.length);
  assert.ok(TICKER_NAMES.length * TICKER_SURNAMES.length >= 1000);
  assert.ok(TICKER_TOWNS.length >= 10);
});

test('winners are always valid and never repeat a name back-to-back', () => {
  let prev = null;
  for (let i = 0; i < 500; i++) {
    const w = nextWinner(prev);
    assert.ok(TICKER_NAMES.includes(w.name));
    assert.ok(TICKER_SURNAMES.includes(w.surname));
    assert.ok(TICKER_TOWNS.includes(w.town));
    assert.notEqual(w.name, prev);
    if (w.jackpot) assert.equal(w.prize, JACKPOT_PRIZE);
    else assert.ok(TICKER_PRIZES.includes(w.prize));
    prev = w.name;
  }
});

test('a stuck RNG cannot repeat the previous name or loop forever', () => {
  const stuck = () => 0;
  const first = nextWinner(null, stuck);
  const second = nextWinner(first.name, stuck);
  assert.notEqual(second.name, first.name);
});

test('jackpots run about 1 in 100 over a long run', () => {
  let jackpots = 0;
  for (let i = 0; i < 10000; i++) if (nextWinner(null).jackpot) jackpots++;
  assert.ok(jackpots > 40 && jackpots < 220, `got ${jackpots} jackpots in 10000`);
});

test('cadence is 2s, and a jackpot line holds 1s longer', () => {
  assert.equal(nextDelayMs({ jackpot: false }), TICKER_INTERVAL_MS);
  assert.equal(nextDelayMs(null), TICKER_INTERVAL_MS);
  assert.equal(nextDelayMs({ jackpot: true }), TICKER_INTERVAL_MS + 1000);
  assert.equal(TICKER_INTERVAL_MS, 2000);
});
