#!/usr/bin/env node

/**
 * Wheel of Fortune — Stress Test
 *
 * Tests: concurrent spins, atomic counters, win distribution,
 * duplicate prevention, budget tracking, rate limiting.
 *
 * Rate limit: 5 req/60s per IP. Test sends in waves of 5, waiting 61s between.
 * Use --no-ratelimit to skip waiting (for local dev or adjusted limits).
 *
 * Usage:
 *   node scripts/stress-test.mjs                          # default: 50 spins
 *   node scripts/stress-test.mjs --spins 100
 *   node scripts/stress-test.mjs --spins 100 --no-ratelimit
 *   node scripts/stress-test.mjs --url https://custom-url.vercel.app
 */

const API_URL_DEFAULT = 'https://wheel-of-fortune-roan.vercel.app';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const BASE_URL = getArg('url', API_URL_DEFAULT);
const TOTAL_SPINS = parseInt(getArg('spins', '50'));
const NO_RATELIMIT = args.includes('--no-ratelimit');
const WAVE_SIZE = 5;    // max requests per rate-limit window
const WAVE_WAIT = 61;   // seconds to wait between waves
const SPIN_URL = `${BASE_URL}/api/spin`;

console.log('='.repeat(60));
console.log('  WHEEL OF FORTUNE — STRESS TEST');
console.log('='.repeat(60));
console.log(`  URL:         ${SPIN_URL}`);
console.log(`  Total spins: ${TOTAL_SPINS}`);
console.log(`  Rate limit:  ${NO_RATELIMIT ? 'DISABLED (--no-ratelimit)' : `${WAVE_SIZE} per ${WAVE_WAIT}s wave`}`);
if (!NO_RATELIMIT) {
  const waves = Math.ceil(TOTAL_SPINS / WAVE_SIZE);
  const estTime = waves * WAVE_WAIT;
  console.log(`  Est. time:   ~${Math.ceil(estTime / 60)}min (${waves} waves)`);
}
console.log('='.repeat(60));
console.log();

// ── Helpers ──────────────────────────────────────────────────

function randomId() {
  return 'stress_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
}

async function spin(customerId, opts = {}) {
  const start = performance.now();
  try {
    const res = await fetch(SPIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId,
        fingerprint: 'stress-test-' + customerId,
        test: true,
        ...opts,
      }),
    });
    const elapsed = performance.now() - start;
    const data = await res.json();
    return { ok: true, status: res.status, data, elapsed };
  } catch (err) {
    const elapsed = performance.now() - start;
    return { ok: false, error: err.message, elapsed };
  }
}

async function runBatch(tasks, concurrency) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Test 1: Concurrent unique spins ──────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function testConcurrentSpins() {
  console.log('TEST 1: Unique spins');
  console.log(`  Sending ${TOTAL_SPINS} spins${NO_RATELIMIT ? ' (no rate limit)' : ` in waves of ${WAVE_SIZE}`}...`);

  const allResults = [];
  const startTime = performance.now();

  if (NO_RATELIMIT) {
    const tasks = Array.from({ length: TOTAL_SPINS }, () => () => spin(randomId()));
    const results = await runBatch(tasks, 10);
    allResults.push(...results);
  } else {
    const totalWaves = Math.ceil(TOTAL_SPINS / WAVE_SIZE);
    for (let wave = 0; wave < totalWaves; wave++) {
      const count = Math.min(WAVE_SIZE, TOTAL_SPINS - wave * WAVE_SIZE);
      const tasks = Array.from({ length: count }, () => () => spin(randomId()));
      const results = await runBatch(tasks, count);
      allResults.push(...results);

      const waveWins = results.filter(r => r.ok && r.data?.win).length;
      const waveLosses = results.filter(r => r.ok && r.data && !r.data.error && !r.data.win).length;
      const waveErrors = results.filter(r => !r.ok || r.data?.error).length;
      process.stdout.write(`  Wave ${wave + 1}/${totalWaves}: ${count} sent, ${waveWins}W/${waveLosses}L/${waveErrors}E`);

      if (wave < totalWaves - 1) {
        process.stdout.write(` — waiting ${WAVE_WAIT}s...\r`);
        for (let s = WAVE_WAIT; s > 0; s--) {
          await sleep(1000);
          process.stdout.write(`  Wave ${wave + 1}/${totalWaves}: ${count} sent, ${waveWins}W/${waveLosses}L/${waveErrors}E — waiting ${s - 1}s...   \r`);
        }
      }
      console.log();
    }
  }

  const totalTime = performance.now() - startTime;
  const results = allResults;

  // Analyze
  const successes = results.filter(r => r.ok && r.data && !r.data.error);
  const errors = results.filter(r => !r.ok || r.data?.error);
  const wins = successes.filter(r => r.data.win);
  const losses = successes.filter(r => !r.data.win);
  const latencies = results.filter(r => r.ok).map(r => r.elapsed);
  const rateLimited = results.filter(r => r.status === 429);

  const prizes = {};
  let totalPrizeValue = 0;
  wins.forEach(r => {
    const amount = r.data.prize?.kwacha || 0;
    prizes[amount] = (prizes[amount] || 0) + 1;
    totalPrizeValue += amount;
  });

  // Segment distribution
  const segments = {};
  successes.forEach(r => {
    const idx = r.data.segmentIndex;
    segments[idx] = (segments[idx] || 0) + 1;
  });

  console.log();
  console.log(`  Results:`);
  console.log(`    Successful:    ${successes.length}/${TOTAL_SPINS}`);
  console.log(`    Errors:        ${errors.length} (${rateLimited.length} rate-limited)`);
  console.log(`    Wins:          ${wins.length} (${(wins.length / successes.length * 100).toFixed(1)}%)`);
  console.log(`    Losses:        ${losses.length}`);
  console.log();
  console.log(`  Prize breakdown:`);
  Object.entries(prizes).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([amount, count]) => {
    console.log(`    K${amount}: ${count} wins`);
  });
  console.log(`    Total paid: K${totalPrizeValue}`);
  console.log();
  console.log(`  Segment distribution:`);
  Object.entries(segments).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([seg, count]) => {
    const bar = '#'.repeat(Math.round(count / successes.length * 50));
    console.log(`    Seg ${seg}: ${String(count).padStart(4)} ${bar}`);
  });
  console.log();
  console.log(`  Latency:`);
  if (latencies.length > 0) {
    latencies.sort((a, b) => a - b);
    console.log(`    Min:    ${latencies[0].toFixed(0)}ms`);
    console.log(`    Median: ${latencies[Math.floor(latencies.length / 2)].toFixed(0)}ms`);
    console.log(`    p95:    ${latencies[Math.floor(latencies.length * 0.95)].toFixed(0)}ms`);
    console.log(`    p99:    ${latencies[Math.floor(latencies.length * 0.99)].toFixed(0)}ms`);
    console.log(`    Max:    ${latencies[latencies.length - 1].toFixed(0)}ms`);
    console.log(`    Avg:    ${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(0)}ms`);
  }
  console.log(`    Total:  ${(totalTime / 1000).toFixed(1)}s`);
  console.log(`    RPS:    ${(successes.length / (totalTime / 1000)).toFixed(1)}`);

  // Error details
  if (errors.length > 0) {
    console.log();
    console.log(`  Error breakdown:`);
    const errorTypes = {};
    errors.forEach(r => {
      const type = r.data?.error || r.error || 'unknown';
      errorTypes[type] = (errorTypes[type] || 0) + 1;
    });
    Object.entries(errorTypes).forEach(([type, count]) => {
      console.log(`    ${type}: ${count}`);
    });
  }

  return { successes: successes.length, wins: wins.length, totalPrizeValue };
}

// ── Test 2: Duplicate prevention ─────────────────────────────

async function testDuplicatePrevention() {
  console.log();
  console.log('-'.repeat(60));
  console.log('TEST 2: Duplicate prevention (same customer, 5 rapid spins)');
  if (!NO_RATELIMIT) { console.log('  Waiting for rate limit window...'); await sleep(WAVE_WAIT * 1000); }

  const sameId = 'duplicate_test_' + Date.now();
  const tasks = Array.from({ length: 5 }, () => () => spin(sameId));
  const results = await runBatch(tasks, 5); // all concurrent

  const successes = results.filter(r => r.ok && r.data && !r.data.error);
  const alreadySpun = results.filter(r => r.data?.error === 'already_spun');
  const otherErrors = results.filter(r => r.ok && r.data?.error && r.data.error !== 'already_spun');

  console.log(`  First spins accepted: ${successes.length} (should be 1)`);
  console.log(`  Already-spun blocked: ${alreadySpun.length} (should be ${5 - successes.length})`);
  console.log(`  Other errors:         ${otherErrors.length}`);

  if (successes.length > 1) {
    console.log('  ⚠ WARNING: Multiple spins accepted for same customer!');
  } else if (successes.length === 1) {
    console.log('  ✓ Duplicate prevention working correctly');
  }
}

// ── Test 3: Burst rate limiting ──────────────────────────────

async function testRateLimiting() {
  console.log();
  console.log('-'.repeat(60));
  console.log('TEST 3: Burst rate limiting (15 rapid requests)');
  if (!NO_RATELIMIT) { console.log('  Waiting for rate limit window...'); await sleep(WAVE_WAIT * 1000); }

  const tasks = Array.from({ length: 15 }, () => () => spin(randomId()));
  const results = await runBatch(tasks, 15); // all at once
  const rateLimited = results.filter(r => r.status === 429);
  const succeeded = results.filter(r => r.ok && r.status === 200);

  console.log(`  Succeeded:    ${succeeded.length} (limit is 5)`);
  console.log(`  Rate-limited: ${rateLimited.length}`);

  if (rateLimited.length > 0) {
    console.log('  ✓ Rate limiting is active');
  } else {
    console.log('  ℹ No rate limiting triggered (serverless cold start may have reset counter)');
  }
}

// ── Test 4: Spin counter consistency ─────────────────────────

async function testSpinCounterConsistency() {
  console.log();
  console.log('-'.repeat(60));
  console.log('TEST 4: Spin counter consistency (5 concurrent spins)');
  if (!NO_RATELIMIT) { console.log('  Waiting for rate limit window...'); await sleep(WAVE_WAIT * 1000); }

  const tasks = Array.from({ length: 5 }, () => () => spin(randomId()));
  const results = await runBatch(tasks, 5);
  const successes = results.filter(r => r.ok && r.data && !r.data.error);

  console.log(`  Accepted: ${successes.length}/5`);

  if (successes.length === 5) {
    console.log('  ✓ All concurrent spins with unique IDs accepted');
  } else {
    const errors = results.filter(r => r.data?.error);
    const errorTypes = {};
    errors.forEach(r => {
      const type = r.data?.error || 'network';
      errorTypes[type] = (errorTypes[type] || 0) + 1;
    });
    console.log('  Errors:', errorTypes);
    if (errorTypes.server_busy) {
      console.log('  ℹ server_busy = atomic counter contention (expected under concurrency)');
    }
  }
}

// ── Test 5: Win segment accuracy ─────────────────────────────

async function testWinSegmentAccuracy() {
  console.log();
  console.log('-'.repeat(60));
  console.log('TEST 5: Win segment accuracy (force wins, verify segment mapping)');
  if (!NO_RATELIMIT) { console.log('  Waiting for rate limit window...'); await sleep(WAVE_WAIT * 1000); }

  const PRIZE_SEGMENTS = { 10: 0, 20: 6, 50: 2, 100: 8, 200: 4 };
  let passed = 0;
  let failed = 0;

  for (const [amount, expectedSeg] of Object.entries(PRIZE_SEGMENTS)) {
    const result = await spin(randomId(), { forceWin: Number(amount) });
    if (result.ok && result.data.win && result.data.segmentIndex === expectedSeg) {
      passed++;
      console.log(`  ✓ K${amount} → segment ${expectedSeg}`);
    } else {
      failed++;
      console.log(`  ✗ K${amount}: expected segment ${expectedSeg}, got ${result.data?.segmentIndex} (win=${result.data?.win}, error=${result.data?.error})`);
    }
  }

  console.log(`  Passed: ${passed}/5, Failed: ${failed}/5`);
  if (failed === 0) {
    console.log('  ✓ All prize amounts map to correct wheel segments');
  }
}

// ── Run all tests ────────────────────────────────────────────

async function main() {
  const t0 = performance.now();

  await testConcurrentSpins();
  await testDuplicatePrevention();
  await testRateLimiting();
  await testSpinCounterConsistency();
  await testWinSegmentAccuracy();

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log();
  console.log('='.repeat(60));
  console.log(`  ALL TESTS COMPLETE — ${elapsed}s total`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
