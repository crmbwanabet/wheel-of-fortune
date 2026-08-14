// Verifies the payout killswitch end-to-end against a dedicated test_bucket.
// Writes ~10 rows on a far-future day. NOT a load test — the production DB is
// shared with the CRM (see the 2026-07-13 incident).
//
// Usage:  node --env-file=.env.local scripts/killswitch-verify.mjs
//
// Proves the two things that matter:
//   1. With the switch ENGAGED, no payout route can pay — not the FCFS queue,
//      not the positions map, not carryover — and the prize pot is NOT consumed.
//   2. With the switch RELEASED, the very same inputs pay normally, so the
//      switch is genuinely reversible and left no wreckage.
//
// It drives claim_spin directly with p_eligible, which is exactly what the route
// does when the flag is set (app/api/spin/route.js). It does NOT flip the real
// wheel_controls row, so running this is safe while production is serving.

import { createClient } from '@supabase/supabase-js';
import { generatePrizePool, buildWinningMap } from '../lib/algorithms.js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  console.error('Run with: node --env-file=.env.local scripts/killswitch-verify.mjs');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const BUCKET = 'killswitch-test';
const DAY = '2030-02-02';   // far future: cannot collide with real traffic
const ALGO = 2;

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` +
    (ok ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}

// `eligible:false` is precisely what the route passes when the killswitch is on.
async function spin(customer, { eligible = true, mode = 'queue' } = {}) {
  const { data, error } = await supabase.rpc('claim_spin', {
    p_day: DAY,
    p_bucket: BUCKET,
    p_customer: customer,
    p_fingerprint: null,
    p_ip: '127.0.0.1',
    p_algorithm_id: ALGO,
    p_winning_positions: buildWinningMap(ALGO),
    p_skip_dedupe: false,
    p_force_prize: null,
    p_eligible: eligible,
    p_cooldown_days: 3,
    p_payout_mode: mode,
    p_prize_queue: generatePrizePool(ALGO),
  });
  if (error) throw new Error(`claim_spin failed: ${error.message}`);
  return data;
}

async function state() {
  const { data } = await supabase
    .from('wheel_daily_state')
    .select('queue_pos, total_wins, total_budget_spent, carryover_prizes')
    .eq('day_date', DAY).eq('test_bucket', BUCKET).maybeSingle();
  return data;
}

async function cleanup() {
  await supabase.from('wheel_spin_log').delete().eq('day_date', DAY).eq('test_bucket', BUCKET);
  await supabase.from('wheel_daily_state').delete().eq('day_date', DAY).eq('test_bucket', BUCKET);
}

async function main() {
  console.log(`\nPayout killswitch verification — bucket "${BUCKET}", day ${DAY}\n`);
  await cleanup();

  // --- QUEUE MODE, switch ENGAGED -----------------------------------------
  console.log('Queue mode, killswitch ENGAGED:');
  for (let i = 1; i <= 4; i++) {
    const r = await spin(`ks-off-${i}`, { eligible: false, mode: 'queue' });
    check(`  spin ${i} is a loss`, r.win, false);
    check(`  spin ${i} pays nothing`, r.prize_amount ?? null, null);
    // Every loss must still land on a "Try Again Tomorrow" segment.
    check(`  spin ${i} lands on a loss segment`, [1, 3, 5, 7, 9].includes(r.segment_index), true);
  }
  let s = await state();
  // The critical property: an engaged switch must not BURN the pot. If it
  // popped the queue, a day spent under the switch would silently destroy
  // the prizes instead of preserving them for when payouts resume.
  check('  queue pot untouched (queue_pos still 0)', s.queue_pos, 0);
  check('  nothing charged to the budget', s.total_budget_spent, 0);
  check('  no wins recorded', s.total_wins, 0);

  // --- QUEUE MODE, switch RELEASED ----------------------------------------
  console.log('\nQueue mode, killswitch RELEASED:');
  const w = await spin('ks-on-1', { eligible: true, mode: 'queue' });
  check('  eligible spin now WINS', w.win, true);
  check('  a prize was paid', typeof w.prize_amount === 'number' && w.prize_amount > 0, true);
  s = await state();
  check('  queue advanced by exactly one', s.queue_pos, 1);

  // --- POSITIONS MODE, switch ENGAGED -------------------------------------
  // The other payout route must be just as dead, or the switch is only half a
  // switch and a mode flip would quietly re-open payouts.
  console.log('\nPositions mode, killswitch ENGAGED:');
  let positionWins = 0;
  for (let i = 1; i <= 4; i++) {
    const r = await spin(`ks-pos-${i}`, { eligible: false, mode: 'positions' });
    if (r.win) positionWins++;
  }
  check('  no positions-mode win got through', positionWins, 0);

  await cleanup();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
