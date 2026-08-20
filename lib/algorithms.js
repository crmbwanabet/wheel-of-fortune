// ============================================================================
// PRIZE DISTRIBUTION ALGORITHMS
// Each totals exactly K2,000 across exactly POOL_SIZE (200) wins.
// ============================================================================

import { WIN_SEGMENTS, LOSS_SEGMENTS } from './wheelSegments.js';
export { SEGMENT_COUNT, JACKPOT_SEGMENT_INDEX, WIN_SEGMENTS, LOSS_SEGMENTS } from './wheelSegments.js';

// Every ladder: exactly 200 wins totalling exactly K2,000, so the average win
// is exactly K10. Weighted to the
// small end. Amounts are restricted to VALID_PRIZE_AMOUNTS — claim_spin maps
// prize amount to wheel segment and RAISEs on anything outside that set.
export const POOL_SIZE = 200;
export const DAILY_BUDGET = 2000;
export const VALID_PRIZE_AMOUNTS = [5, 10, 20, 50, 100, 200];

export const ALGORITHMS = {
  1: { name: 'Drizzle',   prizes: { 5: 108, 10: 76, 20: 10, 50: 4, 100: 1, 200: 1 } },
  2: { name: 'Balanced',  prizes: { 5: 114, 10: 72, 20: 8,  50: 3, 100: 2, 200: 1 } },
  3: { name: 'K50-heavy', prizes: { 5: 128, 10: 58, 20: 4,  50: 8, 100: 1, 200: 1 } },
  4: { name: 'Top-heavy', prizes: { 5: 134, 10: 57, 20: 3,  50: 2, 100: 2, 200: 2 } },
  5: { name: 'K20-heavy', prizes: { 5: 112, 10: 64, 20: 20, 50: 2, 100: 1, 200: 1 } },
};

// The winnable position space: 100 winning slots are scattered across the first
// WINNABLE_POSITIONS spins of the day, so only those spins can land on a win.
// Spins beyond this (spin_number > WINNABLE_POSITIONS) have no winning slot.
export const WINNABLE_POSITIONS = 10000;

// Weighted pool: algo 4 (top-heavy) appears once, others twice
const SELECTION_POOL = [1, 1, 2, 2, 3, 3, 4, 5, 5];

export function pickAlgorithm() {
  return SELECTION_POOL[Math.floor(Math.random() * SELECTION_POOL.length)];
}

export function generatePrizePool(algorithmId) {
  const algo = ALGORITHMS[algorithmId];
  if (!algo) throw new Error(`Unknown algorithm: ${algorithmId}`);

  const pool = [];
  for (const [amount, count] of Object.entries(algo.prizes)) {
    for (let i = 0; i < count; i++) {
      pool.push(Number(amount));
    }
  }

  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool;
}

export function generateWinningPositions(count = POOL_SIZE) {
  const positions = new Set();
  while (positions.size < count) {
    positions.add(Math.floor(Math.random() * WINNABLE_POSITIONS) + 1);
  }
  return Array.from(positions).sort((a, b) => a - b);
}

export function buildWinningMap(algorithmId) {
  const prizes = generatePrizePool(algorithmId);
  const positions = generateWinningPositions(prizes.length);
  const map = {};
  positions.forEach((pos, i) => {
    map[String(pos)] = prizes[i];
  });
  return map;
}

export function getWheelDayDate() {
  const now = new Date();
  const catMs = now.getTime() + (2 * 60 * 60 * 1000);
  const catDate = new Date(catMs);
  if (catDate.getUTCHours() < 9) {
    catDate.setUTCDate(catDate.getUTCDate() - 1);
  }
  return catDate.toISOString().split('T')[0];
}

const PRIZE_TO_SEGMENT = {
  5: 0,
  10: 2,
  20: 4,
  50: 6,
  100: 8,
  200: 10,
};

export function prizeToSegmentIndex(prizeAmount) {
  const idx = PRIZE_TO_SEGMENT[prizeAmount];
  if (idx === undefined) throw new Error(`Unknown prize amount: ${prizeAmount}`);
  return idx;
}

// The mapping and the shared constant must not drift apart.
if (Object.values(PRIZE_TO_SEGMENT).sort((a, b) => a - b).join() !== WIN_SEGMENTS.join()) {
  throw new Error('PRIZE_TO_SEGMENT does not match WIN_SEGMENTS');
}

export function pickLossSegment() {
  return LOSS_SEGMENTS[Math.floor(Math.random() * LOSS_SEGMENTS.length)];
}
