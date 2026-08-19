import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALGORITHMS, generatePrizePool, generateWinningPositions, buildWinningMap,
  POOL_SIZE, DAILY_BUDGET, VALID_PRIZE_AMOUNTS,
} from './algorithms.js';

// generatePrizePool doubles as the FCFS prize queue (spec 2026-08-12): a
// shuffled array of exactly POOL_SIZE prizes totalling exactly K2,000. These
// invariants are what make the queue's budget exact by construction.
// Ladder rework spec: 2026-08-19-prize-ladder-pacing-jackpot-design.md.

test('pool size is 250 and budget is K2,000', () => {
  assert.equal(POOL_SIZE, 250);
  assert.equal(DAILY_BUDGET, 2000);
});

test('valid amounts are exactly K5..K200', () => {
  assert.deepEqual(VALID_PRIZE_AMOUNTS, [5, 10, 20, 50, 100, 200]);
});

for (const [id, algo] of Object.entries(ALGORITHMS)) {
  test(`algorithm ${id} (${algo.name}): 250 prizes summing to K2,000`, () => {
    const pool = generatePrizePool(Number(id));
    assert.equal(pool.length, POOL_SIZE);
    assert.equal(pool.reduce((a, b) => a + b, 0), DAILY_BUDGET);
  });

  test(`algorithm ${id} (${algo.name}): only valid amounts`, () => {
    for (const p of generatePrizePool(Number(id))) {
      assert.ok(VALID_PRIZE_AMOUNTS.includes(p), `unexpected amount ${p}`);
    }
  });

  test(`algorithm ${id} (${algo.name}): shuffle preserves the multiset`, () => {
    const pool = generatePrizePool(Number(id));
    const counts = {};
    for (const p of pool) counts[p] = (counts[p] || 0) + 1;
    assert.deepEqual(counts, Object.fromEntries(
      Object.entries(algo.prizes).map(([amount, count]) => [amount, count])
    ));
  });
}

test('winning positions match the pool size', () => {
  assert.equal(generateWinningPositions(POOL_SIZE).length, POOL_SIZE);
  assert.equal(Object.keys(buildWinningMap(1)).length, POOL_SIZE);
});

test('unknown algorithm id throws', () => {
  assert.throws(() => generatePrizePool(99), /Unknown algorithm/);
});
