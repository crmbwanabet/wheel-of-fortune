// Extensive route-level verification of the payout killswitch.
//
// scripts/killswitch-verify.mjs proves claim_spin honours p_eligible. This
// proves the OTHER half: that /api/spin actually reads wheel_controls and
// passes it through — the wiring that sits between an operator flipping a row
// and a customer seeing "Try Again Tomorrow".
//
// Usage:
//   node --env-file=.env.local scripts/killswitch-route-verify.mjs
//   BASE_URL=http://localhost:3000 MODE_LABEL=queue node --env-file=.env.local ...
//
// Drives real HTTP against a running server, in test mode, against an isolated
// test_bucket. Restores wins_disabled=false on exit, including on failure —
// leaving the switch engaged would silently stop production payouts.

import { createClient } from '@supabase/supabase-js';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const MODE = process.env.MODE_LABEL || 'unknown';
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WHEEL_TEST_TOKEN } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !WHEEL_TEST_TOKEN) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / WHEEL_TEST_TOKEN.');
  console.error('Run with: node --env-file=.env.local scripts/killswitch-route-verify.mjs');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const BUCKET = `ks-route-${MODE}`;
const LOSS_SEGMENTS = [1, 3, 5, 7, 9];

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` +
    (ok ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}

async function setSwitch(on, reason) {
  const { error } = await supabase.from('wheel_controls')
    .update({ wins_disabled: on, reason }).eq('id', 1);
  if (error) throw new Error(`could not set switch: ${error.message}`);
}

async function spin(customer, extra = {}) {
  const res = await fetch(`${BASE}/api/spin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-wheel-test-token': WHEEL_TEST_TOKEN },
    body: JSON.stringify({ test: true, customerId: customer, testBucket: BUCKET, ...extra }),
  });
  return { status: res.status, body: await res.json() };
}

async function state() {
  const { data } = await supabase.from('wheel_daily_state')
    .select('queue_pos, total_wins, total_budget_spent')
    .eq('test_bucket', BUCKET).maybeSingle();
  return data || { queue_pos: 0, total_wins: 0, total_budget_spent: 0 };
}

async function cleanup() {
  await supabase.from('wheel_spin_log').delete().eq('test_bucket', BUCKET);
  await supabase.from('wheel_daily_state').delete().eq('test_bucket', BUCKET);
}

let n = 0;
const id = (tag) => `${tag}-${MODE}-${++n}`;

async function main() {
  console.log(`\n=== Route-level killswitch verification (payout mode: ${MODE}) ===\n`);
  await cleanup();
  await setSwitch(false, 'route verify: baseline');

  // --- A. Baseline: switch off, wins flow -----------------------------------
  console.log('A. Switch OFF — payouts flow');
  const warm = await spin(id('base'));
  check('  spin returns 200', warm.status, 200);
  check('  response has a win field', typeof warm.body.win === 'boolean', true);
  const before = await state();

  // --- B. Engaged: a meaningful sample, zero wins ---------------------------
  console.log('\nB. Switch ON — 30 spins, none may pay');
  await setSwitch(true, 'route verify: engaged');
  const segs = new Set();
  let wins = 0, nonLossSeg = 0, badStatus = 0, prizeLeak = 0;
  for (let i = 0; i < 30; i++) {
    const r = await spin(id('off'));
    if (r.status !== 200) badStatus++;
    if (r.body.win) wins++;
    if (r.body.prize != null) prizeLeak++;
    if (!LOSS_SEGMENTS.includes(r.body.segmentIndex)) nonLossSeg++;
    segs.add(r.body.segmentIndex);
  }
  check('  wins while engaged', wins, 0);
  check('  prizes leaked while engaged', prizeLeak, 0);
  check('  non-200 responses', badStatus, 0);
  check('  spins landing off a "Try Again Tomorrow" segment', nonLossSeg, 0);
  // A wheel that always stops in the same place reads as broken to a customer.
  check('  loss segments are varied (>1 distinct)', segs.size > 1, true);

  const during = await state();
  check('  prize pot NOT consumed (queue_pos unchanged)', during.queue_pos, before.queue_pos);
  check('  budget NOT charged', during.total_budget_spent, before.total_budget_spent);
  check('  win counter NOT advanced', during.total_wins, before.total_wins);

  // --- C. Concurrency: no win slips through under parallel load -------------
  console.log('\nC. Switch ON — 20 concurrent spins');
  const conc = await Promise.all(Array.from({ length: 20 }, () => spin(id('conc'))));
  check('  concurrent wins', conc.filter(r => r.body.win).length, 0);
  check('  concurrent non-200s', conc.filter(r => r.status !== 200).length, 0);

  // --- D. A forced prize must NOT beat the killswitch -----------------------
  // force_prize is test-token gated, but it is the one path that sets a win
  // before eligibility is consulted. If it survived, "stop all wins" would be
  // conditional, and the switch could not be trusted in an emergency.
  console.log('\nD. Switch ON — forced prize must still lose');
  const forced = await spin(id('force'), { forceWin: 100 });
  check('  forced win suppressed', forced.body.win, false);

  // --- E. Dedupe still applies while engaged --------------------------------
  // A customer must not get a free retry just because payouts are paused.
  console.log('\nE. Switch ON — daily dedupe still enforced');
  const dedupeId = id('dedupe');
  await spin(dedupeId, { skipDedupe: false });
  const second = await spin(dedupeId, { skipDedupe: false });
  check('  second spin rejected as already_spun', second.body.error, 'already_spun');

  // --- F. Release: payouts resume, pot intact -------------------------------
  console.log('\nF. Switch OFF — payouts resume');
  await setSwitch(false, 'route verify: released');
  // Checked with a FORCED prize, deliberately — the exact inverse of check D.
  //
  // An earlier version span five times and asserted at least one win. That is
  // only sound in queue mode, where every eligible spin pays. In positions mode
  // a win needs the spin number to hit 1 of 100 slots scattered across 10,000,
  // so five losses is the *expected* result (~95% likely) and the check failed
  // on a perfectly healthy build. A forced prize is deterministic in both modes,
  // and it isolates exactly what this step is about: the switch is released, so
  // the payout path that D proved was closed is now open again.
  const released = await spin(id('on'), { forceWin: 50 });
  check('  a forced prize pays again after release', released.body.win, true);
  check('  and pays the right amount', released.body.prize?.kwacha, 50);
  const after = await state();
  check('  pot resumed from where it paused', after.queue_pos >= during.queue_pos, true);

  // --- G. Latency cost of the extra control read ----------------------------
  console.log('\nG. Added latency of the killswitch read');
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) await spin(id('lat'));
  const perSpin = Math.round((Date.now() - t0) / 10);
  console.log(`  ~${perSpin}ms per spin end-to-end (10 sequential, incl. HTTP + claim_spin)`);

  await cleanup();
  await setSwitch(false, 'route verify: complete');
}

main()
  .then(async () => {
    console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    // Never leave the switch engaged because a test threw.
    try { await setSwitch(false, 'route verify: aborted'); await cleanup(); } catch {}
    console.error('\nABORTED:', e.message, '\n');
    process.exit(1);
  });
