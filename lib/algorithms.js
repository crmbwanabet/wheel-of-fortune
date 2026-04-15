// ============================================================================
// PRIZE DISTRIBUTION ALGORITHMS
// Each totals exactly K2,000 across exactly 100 wins.
// ============================================================================

export const ALGORITHMS = {
  1: { name: 'Drizzle',    prizes: { 10: 55, 20: 35, 50: 7,  100: 2,  200: 1 } },
  2: { name: 'Balanced',   prizes: { 10: 75, 20: 15, 50: 5,  100: 3,  200: 2 } },
  3: { name: 'K50-heavy',  prizes: { 10: 78, 20: 6,  50: 12, 100: 3,  200: 1 } },
  4: { name: 'Top-heavy',  prizes: { 10: 89, 20: 3,  50: 1,  100: 4,  200: 3 } },
  5: { name: 'K20-heavy',  prizes: { 10: 43, 20: 51, 50: 3,  100: 2,  200: 1 } },
};

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

export function generateWinningPositions() {
  const positions = new Set();
  while (positions.size < 100) {
    positions.add(Math.floor(Math.random() * 10000) + 1);
  }
  return Array.from(positions).sort((a, b) => a - b);
}

export function buildWinningMap(algorithmId) {
  const positions = generateWinningPositions();
  const prizes = generatePrizePool(algorithmId);
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
  if (catDate.getUTCHours() < 6) {
    catDate.setUTCDate(catDate.getUTCDate() - 1);
  }
  return catDate.toISOString().split('T')[0];
}

const PRIZE_TO_SEGMENT = {
  10: 0,
  50: 2,
  200: 4,
  20: 6,
  100: 8,
};

export function prizeToSegmentIndex(prizeAmount) {
  const idx = PRIZE_TO_SEGMENT[prizeAmount];
  if (idx === undefined) throw new Error(`Unknown prize amount: ${prizeAmount}`);
  return idx;
}

const LOSS_SEGMENTS = [1, 3, 5, 7, 9];

export function pickLossSegment() {
  return LOSS_SEGMENTS[Math.floor(Math.random() * LOSS_SEGMENTS.length)];
}
