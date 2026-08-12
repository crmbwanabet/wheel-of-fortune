import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSupabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rateLimit';
import {
  getWheelDayDate,
  pickAlgorithm,
  buildWinningMap,
  generatePrizePool,
} from '@/lib/algorithms';
import { sendWinNotification } from '@/lib/telegram';
import { verifyBwanaToken, TokenError } from '@/lib/bwanaAuth.mjs';
import { reportError } from '@/lib/telemetry';
import { checkDepositEligibility } from '@/lib/depositCheck';
import { resolveCooldownDays } from '@/lib/cooldown';

// Colocate with the Supabase database (eu-west-1 / Dublin) to remove
// cross-region round trips from every query on the hot path.
export const preferredRegion = ['dub1'];
export const dynamic = 'force-dynamic';

// Deposit-eligibility gate config. Mode: 'off' (no check) | 'shadow' (check +
// log, outcome unaffected) | 'enforce' (check gates the win). See spec
// 2026-07-21-wheel-deposit-eligibility-gate-design.md.
const DEPOSIT_GATE_MODE = process.env.DEPOSIT_GATE_MODE || 'off';
const DEPOSIT_CHECK_TIMEOUT_MS = Number(process.env.DEPOSIT_CHECK_TIMEOUT_MS) || 2000;
const DEPOSIT_CHECK_BG_CAP_MS = Number(process.env.DEPOSIT_CHECK_BG_CAP_MS) || 10000;

// Payout mode: 'positions' = scattered winning slots (legacy); 'queue' = FCFS
// prize queue — every eligible spin wins until the day's pot is empty. See
// spec 2026-08-12-fcfs-payout-queue-design.md. Env-flip = instant rollback.
const WHEEL_PAYOUT_MODE = process.env.WHEEL_PAYOUT_MODE === 'queue' ? 'queue' : 'positions';

// Spin rate limit (per IP). Raised well above the old 5/min because many
// legitimate customers share carrier-NAT / store IPs — per-customer abuse is
// already prevented by daily dedup + the deposit gate, so this only guards
// against a single IP flooding the DB. Env-tunable without a redeploy.
const SPIN_RATE_LIMIT = Number(process.env.SPIN_RATE_LIMIT) || 60;
const SPIN_RATE_WINDOW_SEC = Number(process.env.SPIN_RATE_WINDOW_SEC) || 60;

// Win cooldown: a customer who won on wheel-day D cannot win on D+1..D+N.
// Env-tunable without a migration; 0 disables the rule (and carry-over with it).
const SPIN_COOLDOWN_DAYS = resolveCooldownDays(process.env.SPIN_COOLDOWN_DAYS);

async function handleSpin(request) {
  // Kill-switch: when set, return immediately WITHOUT touching the database.
  // Used to relieve DB connection pressure during an incident.
  if (process.env.SPIN_MAINTENANCE === '1') {
    return NextResponse.json({ error: 'maintenance' }, { status: 503 });
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  // Test-mode is gated by header secret. Missing/wrong token → body flags ignored.
  const providedToken = request.headers.get('x-wheel-test-token');
  const serverToken = process.env.WHEEL_TEST_TOKEN;
  const isTest = Boolean(serverToken && providedToken && providedToken === serverToken && body.test === true);

  // Authenticated test traffic bypasses the public rate limiter.
  if (!isTest && !(await checkRateLimit('spin', ip, SPIN_RATE_LIMIT, SPIN_RATE_WINDOW_SEC))) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  const { token, customerId, fingerprint } = body;

  // Identity: test traffic keeps using an explicit customerId; real traffic
  // derives the id by decoding the BwanaBet session token (Phase 1: no signature check).
  let cleanId;
  if (isTest) {
    if (!customerId || typeof customerId !== 'string' || customerId.trim() === '') {
      return NextResponse.json({ error: 'missing_customer_id' }, { status: 400 });
    }
    cleanId = customerId.trim();
  } else {
    try {
      cleanId = verifyBwanaToken(token).id;
    } catch (err) {
      const code = err instanceof TokenError && err.code === 'expired' ? 'token_expired' : 'invalid_token';
      return NextResponse.json({ error: code }, { status: 401 });
    }
  }

  const forceWin = isTest && typeof body.forceWin === 'number' ? body.forceWin : null;
  const bucket = isTest
    ? (typeof body.testBucket === 'string' && body.testBucket.length > 0 ? body.testBucket : 'stress')
    : '';
  // In test mode, default to skipping dedupe (load tests use unique IDs). Tests
  // that want to verify dedupe itself send body.skipDedupe:false to force it on.
  const skipDedupe = isTest && body.skipDedupe !== false;
  const dayDate = getWheelDayDate();
  const algorithmId = pickAlgorithm();
  const winningPositions = buildWinningMap(algorithmId);
  // Shuffled 100-prize queue (K2,000 exact). Sent on every spin, but only the
  // day's FIRST spin persists it (day-init); both structures are stored so a
  // mid-day WHEEL_PAYOUT_MODE flip works in either direction.
  const prizeQueue = generatePrizePool(algorithmId);

  const supabase = getSupabase();

  // --- Deposit-eligibility gate ---
  // Real traffic only; test/load traffic bypasses the external call entirely.
  // Effective eligibility feeds claim_spin; the full result is logged async.
  let effectiveEligible = true;      // default: do not block (off / shadow / test)
  let depositCompletion = null;      // Promise<eventual> to log via waitUntil
  let depositSync = null;            // sync verdict for logging
  const gateActive = !isTest && (DEPOSIT_GATE_MODE === 'shadow' || DEPOSIT_GATE_MODE === 'enforce');

  if (gateActive) {
    try {
      const check = await checkDepositEligibility({
        token,
        timeoutMs: DEPOSIT_CHECK_TIMEOUT_MS,
        bgCapMs: DEPOSIT_CHECK_BG_CAP_MS,
      });
      depositSync = check.sync;
      depositCompletion = check.completion;
      if (DEPOSIT_GATE_MODE === 'enforce') {
        effectiveEligible = check.sync.eligible;
      }
    } catch (err) {
      // Never let the gate break a spin. Fail-closed only in enforce mode.
      waitUntil(reportError(err, { route: 'spin', status: 200, code: 'deposit_check_threw' }));
      if (DEPOSIT_GATE_MODE === 'enforce') effectiveEligible = false;
      depositSync = { eligible: effectiveEligible, reason: 'error', latencyMs: null };
    }
  }

  // Atomic claim — day-init (state row + per-day sequence) is folded into
  // claim_spin, so a spin is a single DB round trip.
  const { data: result, error: claimErr } = await supabase.rpc('claim_spin', {
    p_day: dayDate,
    p_bucket: bucket,
    p_customer: cleanId,
    p_fingerprint: fingerprint || null,
    p_ip: ip,
    p_algorithm_id: algorithmId,
    p_winning_positions: winningPositions,
    p_skip_dedupe: skipDedupe,
    p_force_prize: forceWin,
    p_eligible: effectiveEligible,
    p_cooldown_days: SPIN_COOLDOWN_DAYS,
    p_payout_mode: WHEEL_PAYOUT_MODE,
    p_prize_queue: prizeQueue,
  });
  if (claimErr) {
    if (claimErr.code === '57014') {
      waitUntil(reportError(claimErr, { route: 'spin', status: 503, code: 'server_busy' }));
      return NextResponse.json({ error: 'server_busy' }, { status: 503 });
    }
    waitUntil(reportError(claimErr, { route: 'spin', status: 500, code: 'claim_failed', customerId: cleanId }));
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
  if (!result) {
    waitUntil(reportError(new Error('claim_spin returned no result'), { route: 'spin', status: 500, code: 'no_result' }));
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  if (result.error === 'already_spun') {
    return NextResponse.json({ error: 'already_spun' });
  }
  if (result.error) {
    waitUntil(reportError(new Error(`RPC error: ${result.error}`), { route: 'spin', status: 500, code: result.error }));
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  // Telegram notification on real (non-test) wins — dispatched AFTER the response
  // via waitUntil so the spinner returns immediately. waitUntil keeps the
  // serverless function alive for the send without blocking the spin result.
  if (result.win && !isTest) {
    waitUntil(
      sendWinNotification({
        customerId: cleanId,
        prizeAmount: result.prize_amount,
        winsToday: result.wins_today,
        budgetSpent: result.budget_today,
        spinNumber: result.spin_number,
        payoutMode: WHEEL_PAYOUT_MODE,
      }).catch(err => console.error('[spin] Telegram notify failed:', err?.message))
    );
  }

  // Persist the deposit-check outcome (sync verdict + eventual ground truth)
  // off the hot path. Only for real gated traffic.
  if (gateActive && depositSync) {
    const decision = depositSync.eligible ? 'eligible' : 'forced_loss';
    // `enforced` = did the gate ACTUALLY convert a would-be win into a loss?
    // claim_spin reports this via forced_loss_ineligible (only ever true in
    // enforce mode, since shadow passes p_eligible=true). This is the real
    // "a win was blocked" signal — distinct from mode and from decision.
    const enforced = Boolean(result?.forced_loss_ineligible);
    waitUntil((async () => {
      let eventual = null;
      try {
        eventual = depositCompletion
          ? await Promise.race([
              depositCompletion,
              new Promise((r) => setTimeout(() => r({ reason: 'bg_timeout' }), DEPOSIT_CHECK_BG_CAP_MS + 1000)),
            ])
          : null;
      } catch { eventual = null; }
      try {
        await supabase.from('wheel_deposit_checks').insert({
          day_date: dayDate,
          customer_id: cleanId,
          mode: DEPOSIT_GATE_MODE,
          decision,
          enforced,
          reason: depositSync.reason,
          sync_latency_ms: depositSync.latencyMs ?? null,
          eventual_eligible: eventual && typeof eventual.eligible === 'boolean' ? eventual.eligible : null,
          eventual_reason: eventual ? eventual.reason : null,
          eventual_latency_ms: eventual && Number.isFinite(eventual.latencyMs) ? eventual.latencyMs : null,
          http_status: eventual ? (eventual.httpStatus ?? null) : null,
          error_text: eventual ? (eventual.error ?? null) : null,
        });
      } catch (err) {
        reportError(err, { route: 'spin', status: 200, code: 'deposit_log_failed' });
      }
    })());
  }

  return NextResponse.json({
    win: result.win,
    segmentIndex: result.segment_index,
    prize: result.win ? { kwacha: result.prize_amount } : null,
  });
}

// Catch-all: any unhandled/unexpected error is reported (future-proofing) and
// returned as a generic 500. reportError is fire-and-forget via waitUntil.
export async function POST(request) {
  try {
    return await handleSpin(request);
  } catch (err) {
    waitUntil(reportError(err, { route: 'spin', status: 500, code: 'unhandled' }));
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
