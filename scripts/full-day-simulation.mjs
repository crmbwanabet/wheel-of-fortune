#!/usr/bin/env node
/**
 * Full-day simulation: fire ~10,000 spins into one isolated test bucket,
 * verify the rigged-logic invariants:
 *   - exactly 100 wins per 10,000 spins
 *   - total prize budget = exactly K2,000
 *   - prize distribution matches one of the 5 algorithms
 *   - spins beyond 10,000 always lose (winning map exhausted)
 *
 * Then runs targeted edge-case probes:
 *   - duplicate customer mid-run is blocked
 *   - duplicate fingerprint mid-run is blocked
 *   - SQL-injection-shaped customer ID is rejected/safe
 *
 * Usage:
 *   node --env-file=.env.local scripts/full-day-simulation.mjs
 *   node --env-file=.env.local scripts/full-day-simulation.mjs --spins 10000 --concurrency 20
 *   node --env-file=.env.local scripts/full-day-simulation.mjs --local
 */

const args = process.argv.slice(2);
const getArg = (name, fb) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fb; };

const IS_LOCAL = args.includes('--local');
const BASE_URL = getArg('url', IS_LOCAL ? 'http://localhost:3000' : 'https://wheel-of-fortune-roan.vercel.app');
const TOTAL_SPINS = parseInt(getArg('spins', '10000'));
const CONCURRENCY = parseInt(getArg('concurrency', '20'));
const SPIN_URL = `${BASE_URL}/api/spin`;

const TOKEN = process.env.WHEEL_TEST_TOKEN;
if (!TOKEN) { console.error('ERROR: WHEEL_TEST_TOKEN env var required'); process.exit(1); }

const RUN_ID = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
const BUCKET = `fullday-${RUN_ID}`;

// Reference algorithms from lib/algorithms.js
const ALGORITHMS = {
  1: { name: 'Drizzle',    prizes: { 10: 55, 20: 35, 50: 7,  100: 2,  200: 1 } },
  2: { name: 'Balanced',   prizes: { 10: 75, 20: 15, 50: 5,  100: 3,  200: 2 } },
  3: { name: 'K50-heavy',  prizes: { 10: 78, 20: 6,  50: 12, 100: 3,  200: 1 } },
  4: { name: 'Top-heavy',  prizes: { 10: 89, 20: 3,  50: 1,  100: 4,  200: 3 } },
  5: { name: 'K20-heavy',  prizes: { 10: 43, 20: 51, 50: 3,  100: 2,  200: 1 } },
};

function bar(label, n, max) {
  const w = Math.round((n / Math.max(max, 1)) * 40);
  return `  ${label.padStart(8)}: ${String(n).padStart(5)} ${'#'.repeat(w)}`;
}

console.log('='.repeat(64));
console.log('  WHEEL OF FORTUNE — FULL-DAY SIMULATION');
console.log('='.repeat(64));
console.log(`  URL:         ${SPIN_URL}`);
console.log(`  Bucket:      ${BUCKET}`);
console.log(`  Spins:       ${TOTAL_SPINS}`);
console.log(`  Concurrency: ${CONCURRENCY}`);
console.log('='.repeat(64));
console.log();

async function spin(opts = {}) {
  const t0 = performance.now();
  try {
    const res = await fetch(SPIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wheel-test-token': TOKEN },
      body: JSON.stringify({
        customerId: opts.customerId || `sim_${Math.random().toString(36).slice(2, 12)}`,
        fingerprint: opts.fingerprint || `fp_${Math.random().toString(36).slice(2, 12)}`,
        test: true,
        testBucket: BUCKET,
        skipDedupe: opts.skipDedupe ?? true,
        ...opts.bodyOverrides,
      }),
    });
    const data = await res.json();
    return { ok: true, status: res.status, data, ms: performance.now() - t0 };
  } catch (err) {
    return { ok: false, error: err.message, ms: performance.now() - t0 };
  }
}

async function runPool(taskFactory, n, concurrency) {
  const out = [];
  let next = 0;
  const lastReport = { t: performance.now(), done: 0 };
  const worker = async () => {
    while (next < n) {
      const i = next++;
      out[i] = await taskFactory(i);
      if (out.length - lastReport.done >= 200) {
        const dt = (performance.now() - lastReport.t) / 1000;
        const rps = (out.length - lastReport.done) / dt;
        process.stdout.write(`  ${out.length}/${n} (${rps.toFixed(1)} rps)\r`);
        lastReport.t = performance.now();
        lastReport.done = out.length;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write(' '.repeat(60) + '\r');
  return out;
}

// ──────────────────────────────────────────────────────────────────
// PHASE 1: Fire all 10,000 spins
// ──────────────────────────────────────────────────────────────────
console.log(`PHASE 1: Firing ${TOTAL_SPINS} spins into bucket ${BUCKET}...`);
const t0 = performance.now();
const results = await runPool(() => spin(), TOTAL_SPINS, CONCURRENCY);
const elapsed = (performance.now() - t0) / 1000;

const successes = results.filter(r => r.ok && r.data && !r.data.error);
const errors = results.filter(r => !r.ok || r.data?.error);
const wins = successes.filter(r => r.data.win);
const losses = successes.filter(r => !r.data.win);
const latencies = results.filter(r => r.ok).map(r => r.ms).sort((a, b) => a - b);

const prizeBreakdown = {};
let totalPaid = 0;
wins.forEach(r => {
  const k = r.data.prize?.kwacha || 0;
  prizeBreakdown[k] = (prizeBreakdown[k] || 0) + 1;
  totalPaid += k;
});

console.log(`  Done in ${elapsed.toFixed(1)}s (${(successes.length / elapsed).toFixed(1)} rps)`);
console.log();
console.log(`PHASE 1 RESULTS`);
console.log(`  Successful spins: ${successes.length}/${TOTAL_SPINS}`);
console.log(`  Errors:           ${errors.length}`);
console.log(`  Wins:             ${wins.length}`);
console.log(`  Losses:           ${losses.length}`);
console.log(`  Total paid:       K${totalPaid}`);
console.log();
console.log(`  Prize breakdown:`);
[10, 20, 50, 100, 200].forEach(p => {
  console.log(bar(`K${p}`, prizeBreakdown[p] || 0, Math.max(...Object.values(prizeBreakdown), 1)));
});

// ──────────────────────────────────────────────────────────────────
// PHASE 2: Match against the 5 algorithms
// ──────────────────────────────────────────────────────────────────
console.log();
console.log('PHASE 2: Algorithm match');
let matchedAlgo = null;
for (const [id, algo] of Object.entries(ALGORITHMS)) {
  const matches = Object.entries(algo.prizes).every(([prize, count]) => (prizeBreakdown[prize] || 0) === count);
  if (matches) { matchedAlgo = { id, ...algo }; break; }
}

if (matchedAlgo) {
  console.log(`  ✓ Distribution exactly matches algorithm ${matchedAlgo.id} — '${matchedAlgo.name}'`);
} else {
  console.log(`  ✗ Distribution does NOT match any of the 5 algorithms.`);
  console.log(`    Got:`, prizeBreakdown);
}

// ──────────────────────────────────────────────────────────────────
// PHASE 3: Invariants
// ──────────────────────────────────────────────────────────────────
console.log();
console.log('PHASE 3: Invariants');
const expectsExact100 = TOTAL_SPINS >= 10000;
console.log(`  Wins == 100:           ${wins.length === 100 ? '✓' : '✗'} got ${wins.length}${expectsExact100 ? '' : ' (only meaningful at 10000+ spins)'}`);
console.log(`  Total budget == K2000: ${totalPaid === 2000 ? '✓' : '✗'} got K${totalPaid}${expectsExact100 ? '' : ' (only meaningful at 10000+ spins)'}`);
console.log(`  Zero server errors:    ${errors.length === 0 ? '✓' : '✗'} got ${errors.length}`);

// ──────────────────────────────────────────────────────────────────
// PHASE 4: Latency stats
// ──────────────────────────────────────────────────────────────────
if (latencies.length > 0) {
  console.log();
  console.log('PHASE 4: Latency');
  console.log(`  Min:    ${latencies[0].toFixed(0)}ms`);
  console.log(`  Median: ${latencies[Math.floor(latencies.length * 0.5)].toFixed(0)}ms`);
  console.log(`  p95:    ${latencies[Math.floor(latencies.length * 0.95)].toFixed(0)}ms`);
  console.log(`  p99:    ${latencies[Math.floor(latencies.length * 0.99)].toFixed(0)}ms`);
  console.log(`  Max:    ${latencies[latencies.length - 1].toFixed(0)}ms`);
}

// ──────────────────────────────────────────────────────────────────
// PHASE 5: Map-exhaustion probe — spin in the same bucket past 10K
// ──────────────────────────────────────────────────────────────────
console.log();
console.log('PHASE 5: Map exhaustion (3 spins past TOTAL_SPINS in same bucket)');
const exhaustResults = [];
for (let i = 0; i < 3; i++) {
  exhaustResults.push(await spin({}));
}
const allLost = exhaustResults.every(r => r.ok && r.data?.win === false);
console.log(`  Past-map spins:`, exhaustResults.map(r => r.data?.win === true ? `WIN K${r.data.prize?.kwacha}` : 'loss').join(', '));
console.log(`  All losses (expected after map exhaustion): ${allLost ? '✓' : '✗ (means a position 10001+ has a prize, or PHASE 1 left wins on the table)'}`);

// ──────────────────────────────────────────────────────────────────
// PHASE 6: Dedupe — duplicate customer must be blocked
// ──────────────────────────────────────────────────────────────────
console.log();
console.log('PHASE 6: Dedupe edge cases');
const dupCustId = `edge_dupcust_${RUN_ID}`;
const r1 = await spin({ customerId: dupCustId, skipDedupe: false });
const r2 = await spin({ customerId: dupCustId, skipDedupe: false });
console.log(`  Same customer twice: first=${r1.data?.error || 'accepted'}, second=${r2.data?.error || 'accepted'}`);
console.log(`  ${(!r1.data?.error && r2.data?.error === 'already_spun') ? '✓ Customer dedupe holds' : '✗ Customer dedupe broken'}`);

const dupFp = `edge_dupfp_${RUN_ID}`;
const r3 = await spin({ fingerprint: dupFp, skipDedupe: false });
const r4 = await spin({ fingerprint: dupFp, skipDedupe: false });
console.log(`  Same fingerprint twice: first=${r3.data?.error || 'accepted'}, second=${r4.data?.error || 'accepted'}`);
console.log(`  ${(!r3.data?.error && r4.data?.error === 'already_spun') ? '✓ Fingerprint dedupe holds' : '✗ Fingerprint dedupe broken'}`);

// ──────────────────────────────────────────────────────────────────
// PHASE 7: Injection-shaped customer ID
// ──────────────────────────────────────────────────────────────────
console.log();
console.log('PHASE 7: Adversarial inputs');
const sqlAttempt = `'; DROP TABLE wheel_spin_log; --`;
const r5 = await spin({ customerId: sqlAttempt, skipDedupe: true });
console.log(`  SQL-injection-shape ID: status=${r5.status}, error=${r5.data?.error || 'accepted'}`);
console.log(`  ${(r5.ok && (r5.data?.win !== undefined || r5.data?.error)) ? '✓ Handled safely (parameterized)' : '✗ Unexpected behavior'}`);

const longCust = 'x'.repeat(5000);
const r6 = await spin({ customerId: longCust, skipDedupe: true });
console.log(`  5000-char customerId:   status=${r6.status}, error=${r6.data?.error || 'accepted'}`);

const emptyCust = '   ';
const r7 = await spin({ customerId: emptyCust });
console.log(`  Whitespace-only ID:     status=${r7.status}, error=${r7.data?.error || 'accepted'}`);
console.log(`  ${r7.data?.error === 'missing_customer_id' ? '✓ Rejected as expected' : '✗ Should have rejected'}`);

console.log();
console.log('='.repeat(64));
console.log(`  SIMULATION COMPLETE — bucket ${BUCKET} (isolated from prod)`);
console.log('='.repeat(64));
