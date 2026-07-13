#!/usr/bin/env node
/**
 * Concurrency verifier. Fires N spins at a target concurrency into an isolated
 * test bucket, then reports throughput + latency percentiles. Correctness is
 * asserted separately via SQL on the bucket (unique ordinals, budget <= K2000).
 *
 * Usage:
 *   node --env-file=.env.local scripts/concurrency-verify.mjs --url <url> --spins 2000 --concurrency 40
 *
 * Env: WHEEL_TEST_TOKEN. Test buckets never touch real player data.
 */
const args = process.argv.slice(2);
const getArg = (n, fb) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : fb; };
const BASE = getArg('url', 'https://wheel-of-fortune-roan.vercel.app');
const SPINS = parseInt(getArg('spins', '2000'));
const CONC = parseInt(getArg('concurrency', '40'));
const BUCKET = 'conc-' + Date.now().toString(36);
const TOKEN = process.env.WHEEL_TEST_TOKEN;
if (!TOKEN) { console.error('WHEEL_TEST_TOKEN required'); process.exit(1); }

async function spin(i) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api/spin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wheel-test-token': TOKEN },
      body: JSON.stringify({
        customerId: `c_${BUCKET}_${i}`, fingerprint: `f_${BUCKET}_${i}`,
        test: true, testBucket: BUCKET, skipDedupe: true,
      }),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, err: data?.error, ms: performance.now() - t0 };
  } catch (e) { return { status: 0, err: e.message, ms: performance.now() - t0 }; }
}

async function pool(n, conc) {
  const out = []; let next = 0;
  const worker = async () => { while (next < n) { const i = next++; out[i] = await spin(i); } };
  await Promise.all(Array.from({ length: conc }, worker));
  return out;
}

console.log(`Bucket ${BUCKET} — ${SPINS} spins @ concurrency ${CONC} -> ${BASE}`);
const t0 = performance.now();
const r = await pool(SPINS, CONC);
const secs = (performance.now() - t0) / 1000;
const ok = r.filter(x => x.status === 200 && !x.err);
const busy = r.filter(x => x.err === 'server_busy' || x.status === 503);
const failed = r.filter(x => x.status === 0 || (x.status >= 500 && x.status !== 503));
const lat = r.map(x => x.ms).sort((a, b) => a - b);
const pct = p => lat[Math.floor(lat.length * p)]?.toFixed(0);
console.log(`  ok=${ok.length} server_busy=${busy.length} failed=${failed.length}`);
console.log(`  rps=${(ok.length / secs).toFixed(0)} p50=${pct(0.5)}ms p95=${pct(0.95)}ms p99=${pct(0.99)}ms max=${lat.at(-1)?.toFixed(0)}ms`);
console.log(`  BUCKET=${BUCKET}`);
