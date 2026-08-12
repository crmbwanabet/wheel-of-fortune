// Verifies the win cooldown + carry-over behaviour of claim_spin against a
// dedicated test_bucket. Writes ~15 rows. NOT a load test — the production DB
// is shared with the CRM (see the 2026-07-13 incident).
//
// Usage:  node --env-file=.env.local scripts/cooldown-verify.mjs
//
// Uses Node's built-in --env-file rather than parsing .env.local by hand:
// that file has mixed CRLF/LF line endings, and a naive /^([A-Z_]+)=(.*)$/
// silently fails to match the CRLF lines entirely (`.` does not match `\r`),
// leaving the credentials undefined. Matches scripts/concurrency-verify.mjs.

import { createClient } from '@supabase/supabase-js';
import { shiftWheelDay } from '../lib/cooldown.js';

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  console.error('Run with: node --env-file=.env.local scripts/cooldown-verify.mjs');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const BUCKET = 'cooldown-test';
const DAY = '2030-01-10';            // far future: cannot collide with real traffic
const PREV = shiftWheelDay(DAY, -1); // inside the cooldown window
const OLD = shiftWheelDay(DAY, -4);  // outside the cooldown window

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}

async function spin(customer, { eligible = true, forcePrize = null, day = DAY } = {}) {
  const { data, error } = await supabase.rpc('claim_spin', {
    p_day: day,
    p_bucket: BUCKET,
    p_customer: customer,
    p_fingerprint: null,
    p_ip: '127.0.0.1',
    p_algorithm_id: 2,
    p_winning_positions: {},   // no positional wins — forcePrize drives wins
    p_skip_dedupe: false,
    p_force_prize: forcePrize,
    p_eligible: eligible,
    p_cooldown_days: 3,
  });
  if (error) throw new Error(`claim_spin failed: ${error.message}`);
  return data;
}

async function queue(day = DAY) {
  const { data } = await supabase
    .from('wheel_daily_state')
    .select('carryover_prizes')
    .eq('day_date', day).eq('test_bucket', BUCKET).maybeSingle();
  return data ? data.carryover_prizes : null;
}

async function carriedIn(day) {
  const { data } = await supabase
    .from('wheel_daily_state')
    .select('carryover_in')
    .eq('day_date', day).eq('test_bucket', BUCKET).maybeSingle();
  return data ? data.carryover_in : null;
}

async function seedWin(customer, day, prize) {
  const { error } = await supabase.from('wheel_spin_log').insert({
    day_date: day, test_bucket: BUCKET, customer_id: customer,
    spin_number: 1, won: true, prize_amount: prize, segment_index: 0,
  });
  if (error) throw new Error(`seed failed: ${error.message}`);
}

async function cleanup() {
  await supabase.from('wheel_spin_log').delete().eq('test_bucket', BUCKET);
  await supabase.from('wheel_daily_state').delete().eq('test_bucket', BUCKET);
}

async function main() {
  await cleanup();

  // 1. A recent winner is blocked, and the prize is queued rather than burned.
  await seedWin('cd-recent', PREV, 50);
  const blocked = await spin('cd-recent', { forcePrize: 50 });
  check('recent winner does not win', blocked.win, false);
  check('block is attributed to the cooldown', blocked.forced_loss_cooldown, true);
  check('block is NOT attributed to the deposit gate', blocked.forced_loss_ineligible, false);
  check('prize is queued for carry-over', await queue(), [50]);

  // 2. An ineligible spinner must NOT collect the queued prize.
  const ineligible = await spin('cd-ineligible', { eligible: false });
  check('ineligible spinner does not collect', ineligible.carryover_awarded, false);
  check('queue is untouched by an ineligible spinner', await queue(), [50]);

  // 3. A spinner who is themselves in cooldown must NOT collect.
  await seedWin('cd-alsorecent', PREV, 10);
  const alsoRecent = await spin('cd-alsorecent');
  check('a spinner in cooldown does not collect', alsoRecent.carryover_awarded, false);
  check('queue is untouched by a cooling-down spinner', await queue(), [50]);

  // 4. The next fully-qualified spinner collects it.
  const collector = await spin('cd-collector');
  check('qualifying spinner collects the carry-over', collector.carryover_awarded, true);
  check('collector wins', collector.win, true);
  check('collector receives the exact banked prize', collector.prize_amount, 50);
  check('queue is drained', await queue(), []);

  // 5. A win older than the window does not block.
  await seedWin('cd-old', OLD, 20);
  const oldWinner = await spin('cd-old', { forcePrize: 20 });
  check('a win 4 days ago does not block', oldWinner.win, true);
  check('no cooldown attribution for an old win', oldWinner.forced_loss_cooldown, false);

  // 6. Concurrency: one banked prize, two qualifying spinners at once.
  await seedWin('cd-recent2', PREV, 100);
  await spin('cd-recent2', { forcePrize: 100 });
  check('second prize is queued', await queue(), [100]);
  const [a, b] = await Promise.all([spin('cd-race-a'), spin('cd-race-b')]);
  const awarded = [a, b].filter((r) => r.carryover_awarded).length;
  check('exactly one racer collects the single queued prize', awarded, 1);
  check('queue is drained after the race', await queue(), []);

  // 7. Carry-forward: a prize left queued when the wheel-day ends must move
  //    into the next day rather than being orphaned. This is the whole point of
  //    the 2026-08-05 migration — before it, the prize below was lost at reset.
  await seedWin('cf-recent', PREV, 200);
  await spin('cf-recent', { forcePrize: 200 });
  check('prize is queued on the closing day', await queue(DAY), [200]);

  //    Open the NEXT wheel-day with an INELIGIBLE spinner. That still creates
  //    the day's state row, but an ineligible player cannot collect, so the
  //    carried queue is observable before anything drains it.
  const nextDay = shiftWheelDay(DAY, 1);
  const opener = await spin('cf-opener', { day: nextDay, eligible: false });
  check('the ineligible opener does not collect', opener.carryover_awarded, false);
  check('the unclaimed prize moved to the new day', await queue(nextDay), [200]);
  check('the new day records what it was handed', await carriedIn(nextDay), [200]);
  check('the old day queue is cleared, so it cannot be carried twice', await queue(DAY), []);

  //    Now a fully-qualified loser on the new day collects it. In production
  //    this happens within minutes: traffic spikes to ~50 spins/min right
  //    after the 06:00 reset.
  const nextDayCollector = await spin('cf-collector', { day: nextDay });
  check('a qualifying spinner on the new day collects the carried prize', nextDayCollector.carryover_awarded, true);
  check('and receives the exact carried amount', nextDayCollector.prize_amount, 200);
  check('new day queue drains after collection', await queue(nextDay), []);

  // 8. Nothing is carried twice: a further new day starts empty.
  const dayAfter = shiftWheelDay(DAY, 2);
  await spin('cf-dayafter', { day: dayAfter });
  check('a later day starts with an empty queue', await queue(dayAfter), []);
  check('and records nothing carried in', await carriedIn(dayAfter), []);

  await cleanup();

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('verification threw:', err.message);
  await cleanup();
  process.exit(1);
});
