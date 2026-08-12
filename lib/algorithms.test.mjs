import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALGORITHMS, generatePrizePool } from './algorithms.js';

// generatePrizePool doubles as the FCFS prize queue (spec 2026-08-12): a
// shuffled array of exactly 100 prizes totalling exactly K2,000. These
// invariants are what make the queue's budget exact by construction.

for (const [id, algo] of Object.entries(ALGORITHMS)) {
  test(`algorithm ${id} (${algo.name}): pool has exactly 100 prizes summing to K2,000`, () => {
    const pool = generatePrizePool(Number(id));
    assert.equal(pool.length, 100);
    assert.equal(pool.reduce((a, b) => a + b, 0), 2000);
  });

  test(`algorithm ${id} (${algo.name}): shuffle preserves the prize multiset`, () => {
    const pool = generatePrizePool(Number(id));
    const counts = {};
    for (const p of pool) counts[p] = (counts[p] || 0) + 1;
    assert.deepEqual(counts, Object.fromEntries(
      Object.entries(algo.prizes).map(([amount, count]) => [amount, count])
    ));
  });
}

test('unknown algorithm id throws', () => {
  assert.throws(() => generatePrizePool(99), /Unknown algorithm/);
});
