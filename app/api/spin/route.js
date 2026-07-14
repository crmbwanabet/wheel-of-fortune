import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSupabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rateLimit';
import {
  getWheelDayDate,
  pickAlgorithm,
  buildWinningMap,
} from '@/lib/algorithms';
import { sendWinNotification } from '@/lib/telegram';
import { verifyBwanaToken, TokenError } from '@/lib/bwanaAuth.mjs';
import { reportError } from '@/lib/telemetry';

// Colocate with the Supabase database (eu-west-1 / Dublin) to remove
// cross-region round trips from every query on the hot path.
export const preferredRegion = ['dub1'];
export const dynamic = 'force-dynamic';

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
  if (!isTest && !(await checkRateLimit('spin', ip))) {
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

  const supabase = getSupabase();

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
      }).catch(err => console.error('[spin] Telegram notify failed:', err?.message))
    );
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
