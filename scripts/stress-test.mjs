#!/usr/bin/env node

/**
 * Wheel of Fortune — Stress Test
 *
 * Tests: concurrent spins, atomic counters, win distribution,
 * duplicate prevention, budget tracking, rate limiting.
 *
 * Requires WHEEL_TEST_TOKEN env var (same value as the server's
 * WHEEL_TEST_TOKEN). Test-mode traffic is isolated from prod via a
 * unique test_bucket per run — it does NOT consume the real daily
 * winning-position map or budget.
 *
 * Rate limit: 5 req/60s per IP. Test sends in waves of 5, waiting 61s between.
 * Use --no-ratelimit for local dev (skips waiting).
 *
 * Usage:
 *   node --env-file=.env.local scripts/stress-test.mjs                      # default: 50 spins, prod URL
 *   node --env-file=.env.local scripts/stress-test.mjs --local --no-ratelimit --spins 100
 *   node --env-file=.env.local scripts/stress-test.mjs --url https://custom.vercel.app
 *
 * Requires Node 20+ for --env-file. Or set WHEEL_TEST_TOKEN manually:
 *   WHEEL_TEST_TOKEN=... node scripts/stress-test.mjs --local --no-ratelimit --spins 100
 */

const API_URL_DEFAULT = 'https://wheel-of-fortune-roan.vercel.app';
const LOCAL_URL = 'http://localhost:3000';

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const IS_LOCAL = args.includes('--local');
const BASE_URL = getArg('url', IS_LOCAL ? LOCAL_URL : API_URL_DEFAULT);
const TOTAL_SPINS = parseInt(getArg('spins', '50'));
const NO_RATELIMIT = args.includes('--no-ratelimit');
const WAVE_SIZE = 5;
const WAVE_WAIT = 61;
const SPIN_URL = `${BASE_URL}/api/spin`;

const TOKEN = process.env.WHEEL_TEST_TOKEN;
if (!TOKEN) {
  console.error('ERROR: WHEEL_TEST_TOKEN env var is required.');
  console.error('Set it to the same value as the server\'s WHEEL_TEST_TOKEN.');
  console.error('Example: WHEEL_TEST_TOKEN=abc123... node scripts/stress-test.mjs');
  process.exit(1);
}

// Unique bucket per run so runs don't collide on dedupe or exhaust the winning map
const RUN_ID = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
const TEST_BUCKET = `stress-${RUN_ID}`;

console.log('='.repeat(60));
console.log('  WHEEL OF FORTUNE — STRESS TEST');
console.log('='.repeat(60));
console.log(`  URL:         ${SPIN_URL}`);
console.log(`  Test bucket: ${TEST_BUCKET}`);
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
      headers: {
        'Content-Type': 'application/json',
        'x-wheel-test-token': TOKEN,
      },
      body: JSON.stringify({
        customerId,
        fingerprint: 'stress-test-' + customerId,
        test: true,
        testBucket: TEST_BUCKET,
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForRateLimit(label = '') {
  if (NO_RATELIMIT) return;
  console.log(`  Waiting for rate limit window (${WAVE_WAIT}s)${label ? ': ' + label : ''}...`);
  await sleep(WAVE_WAIT * 1000);
}

// ── Test 1: Concurrent unique spins ──────────────────────────

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

  const successes = results.filter(r => r.ok && r.data && !r.data.error);
  const errors = results.filter(r => !r.ok || r.data?.error);
  const wins = successes.filter(r => r.data.win);
  const losses = successes.filter(r => !r.data.win);
  const latencies = results.filter(r => r.ok).map(r => r.elapsed);
  const rateLimited = results.filter(r => r.status === 429);
  const serverBusy = results.filter(r => r.data?.error === 'server_busy');

  const prizes = {};
  let totalPrizeValue = 0;
  wins.forEach(r => {
    const amount = r.data.prize?.kwacha || 0;
    prizes[amount] = (prizes[amount] || 0) + 1;
    totalPrizeValue += amount;
  });

  const segments = {};
  successes.forEach(r => {
    const idx = r.data.segmentIndex;
    segments[idx] = (segments[idx] || 0) + 1;
  });

  console.log();
  console.log(`  Results:`);
  console.log(`    Successful:    ${successes.length}/${TOTAL_SPINS}`);
  console.log(`    Errors:        ${errors.length} (${rateLimited.length} rate-limited, ${serverBusy.length} server_busy)`);
  console.log(`    Wins:          ${wins.length} (${(wins.length / Math.max(successes.length, 1) * 100).toFixed(1)}%)`);
  console.log(`    Losses:        ${losses.length}`);
  console.log();
  console.log(`  Prize breakdown:`);
  Object.entries(prizes).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([amount, count]) => {
    console.log(`    K${amount}: ${count} wins`);
  });
  console.log(`    Total paid: K${totalPrizeValue} (test bucket, not real budget)`);
  console.log();
  console.log(`  Segment distribution:`);
  Object.entries(segments).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([seg, count]) => {
    const bar = '#'.repeat(Math.round(count / Math.max(successes.length, 1) * 50));
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

  return { successes: successes.length, wins: wins.length, totalPrizeValue, serverBusy: serverBusy.length };
}

// ── Test 2: Duplicate prevention ─────────────────────────────

async function testDuplicatePrevention() {
  console.log();
  console.log('-'.repeat(60));
  console.log('TEST 2: Duplicate prevention (same customer, 5 rapid spins)');
  await waitForRateLimit();

  // skipDedupe:false forces the server to apply dedupe even in test mode.
  // All 5 spins share the same customerId — only the first should succeed.
  const sameId = 'duplicate_test_' + Date.now();
  const tasks = Array.from({ length: 5 }, () => () => spin(sameId, { skipDedupe: false }));
  const results = await runBatch(tasks, 5);

  const successes = results.filter(r => r.ok && r.data && !r.data.error);
  const alreadySpun = results.filter(r => r.data?.error === 'already_spun');
  const otherErrors = results.filter(r => r.ok && r.data?.error && r.data.error !== 'already_spun');

  console.log(`  First spins accepted: ${successes.length} (should be 1)`);
  console.log(`  Already-spun blocked: ${alreadySpun.length} (should be ${5 - successes.length})`);
  console.log(`  Other errors:         ${otherErrors.length}`);

  if (successes.length === 1 && alreadySpun.length === 4) {
    console.log('  ✓ Duplicate prevention working correctly');
  } else if (successes.length > 1) {
    console.log('  ✗ Multiple spins accepted for same customer — dedupe broken');
  } else {
    console.log('  ⚠ Unexpected result — inspect error breakdown');
  }
}

// ── Test 3: Burst rate limiting ──────────────────────────────

async function testRateLimiting() {
  console.log();
  console.log('-'.repeat(60));
  console.log('TEST 3: Burst rate limiting (15 rapid requests, no token)');
  await waitForRateLimit();

  // Fresh IP, no token — exercises the public rate limiter in isolation.
  const sharedIp = `88.88.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  async function spinNoToken() {
    try {
      const res = await fetch(SPIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': sharedIp },
        body: JSON.stringify({ customerId: randomId(), fingerprint: 'rl-test' }),
      });
      const data = await res.json().catch(() => null);
      return { ok: true, status: res.status, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  const tasks = Array.from({ length: 15 }, () => spinNoToken);
  const results = await runBatch(tasks, 15);
  const rateLimited = results.filter(r => r.status === 429);
  const succeeded = results.filter(r => r.ok && r.status === 200);

  console.log(`  Succeeded:    ${succeeded.length} (limit is 5)`);
  console.log(`  Rate-limited: ${rateLimited.length}`);

  if (rateLimited.length >= 10) {
    console.log('  ✓ Rate limiting working correctly (10+ requests blocked)');
  } else if (rateLimited.length > 0) {
    console.log('  ⚠ Rate limiting partially active (may indicate serverless cold-start state drift)');
  } else {
    console.log('  ✗ Rate limiting NOT triggered — check checkRateLimit()');
  }
}

// ── Test 4: Atomic counter contention (NEW) ──────────────────

async function testAtomicCounter() {
  console.log();
  console.log('-'.repeat(60));
  console.log('TEST 4: Atomic counter contention (20 concurrent spins)');
  await waitForRateLimit();

  if (!NO_RATELIMIT) {
    console.log('  Skipped: needs --no-ratelimit to exceed 5 req/min.');
    return;
  }

  // All unique customer IDs, all fired simultaneously, all against same (day, bucket).
  // Proves: every caller gets a unique spin_number, zero server_busy, zero loss.
  const N = 20;
  const tasks = Array.from({ length: N }, () => () => spin(randomId()));
  const results = await runBatch(tasks, N);

  const successes = results.filter(r => r.ok && r.data && !r.data.error);
  const serverBusy = results.filter(r => r.data?.error === 'server_busy');
  const other = results.filter(r => !r.ok || (r.data?.error && r.data.error !== 'server_busy'));

  console.log(`  Succeeded:    ${successes.length}/${N}`);
  console.log(`  server_busy:  ${serverBusy.length} (should be 0)`);
  console.log(`  Other errors: ${other.length}`);

  if (successes.length === N && serverBusy.length === 0) {
    console.log('  ✓ Atomic counter held — all concurrent spins accepted, zero contention');
  } else {
    console.log('  ✗ Contention detected — RPC atomicity may be broken');
    other.forEach(r => console.log(`    - ${r.data?.error || r.error}`));
  }
}

// ── Test 5: Win segment accuracy (force wins) ────────────────

async function testWinSegmentAccuracy() {
  console.log();
  console.log('-'.repeat(60));
  console.log('TEST 5: Win segment accuracy (force wins, verify segment mapping)');
  await waitForRateLimit();

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

// ── Test 6: Security — test:true without token is ignored ────

async function testTokenSecurity() {
  console.log();
  console.log('-'.repeat(60));
  console.log('TEST 6: Security — test:true without token must be ignored');

  // Use a fresh simulated IP so Test 3's rate-limit residue doesn't block this.
  // Send test:true + forceWin:200 but NO x-wheel-test-token header.
  // Server should NOT honor forceWin: should get a loss (or a map-driven win),
  // never a guaranteed K200.
  const freshIp = `99.99.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  const cid = 'sec_' + randomId();
  const start = performance.now();
  const res = await fetch(SPIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': freshIp,
      // NO x-wheel-test-token header
    },
    body: JSON.stringify({ customerId: cid, fingerprint: 'sec-' + cid, test: true, forceWin: 200 }),
  });
  const elapsed = performance.now() - start;
  const data = await res.json().catch(() => null);

  const isForced = data?.win === true && data?.prize?.kwacha === 200;
  console.log(`  Response: status=${res.status}, win=${data?.win}, prize=${data?.prize?.kwacha}, error=${data?.error}`);
  console.log(`  Elapsed:  ${elapsed.toFixed(0)}ms`);

  if (res.status === 429 || data?.error === 'rate_limited') {
    console.log('  ⚠ Request rate-limited before reaching test-mode logic — result inconclusive.');
    console.log('    (Run with a cold rate-limit window or a fresh IP to verify.)');
  } else if (isForced) {
    console.log('  ✗ SECURITY HOLE — forceWin:200 was honored without token!');
  } else {
    console.log('  ✓ Token gate working — forceWin ignored, request processed as normal traffic');
  }
}

// ── Run all tests ────────────────────────────────────────────

async function main() {
  const t0 = performance.now();

  await testConcurrentSpins();
  await testDuplicatePrevention();
  await testRateLimiting();
  await testAtomicCounter();
  await testWinSegmentAccuracy();
  await testTokenSecurity();

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log();
  console.log('='.repeat(60));
  console.log(`  ALL TESTS COMPLETE — ${elapsed}s total`);
  console.log(`  Test bucket: ${TEST_BUCKET} (isolated from prod)`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
