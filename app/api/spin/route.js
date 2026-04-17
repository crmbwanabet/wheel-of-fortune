import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rateLimit';
import {
  getWheelDayDate,
  pickAlgorithm,
  buildWinningMap,
} from '@/lib/algorithms';
import { sendWinNotification } from '@/lib/telegram';

export async function POST(request) {
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

  const { customerId, fingerprint } = body;

  if (!customerId || typeof customerId !== 'string' || customerId.trim() === '') {
    return NextResponse.json({ error: 'missing_customer_id' }, { status: 400 });
  }
  const forceWin = isTest && typeof body.forceWin === 'number' ? body.forceWin : null;
  const bucket = isTest
    ? (typeof body.testBucket === 'string' && body.testBucket.length > 0 ? body.testBucket : 'stress')
    : '';
  // In test mode, default to skipping dedupe (load tests use unique IDs). Tests
  // that want to verify dedupe itself send body.skipDedupe:false to force it on.
  const skipDedupe = isTest && body.skipDedupe !== false;

  const cleanId = customerId.trim();
  const dayDate = getWheelDayDate();
  const algorithmId = pickAlgorithm();
  const winningPositions = buildWinningMap(algorithmId);

  const supabase = getSupabase();

  // Idempotent day init
  const { error: ensureErr } = await supabase.rpc('ensure_daily_state', {
    p_day: dayDate,
    p_bucket: bucket,
    p_algorithm_id: algorithmId,
    p_winning_positions: winningPositions,
  });
  if (ensureErr) {
    console.error('[spin] ensure_daily_state failed:', ensureErr);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  // Atomic claim
  const { data: result, error: claimErr } = await supabase.rpc('claim_spin', {
    p_day: dayDate,
    p_bucket: bucket,
    p_customer: cleanId,
    p_fingerprint: fingerprint || null,
    p_ip: ip,
    p_skip_dedupe: skipDedupe,
    p_force_prize: forceWin,
  });
  if (claimErr || !result) {
    console.error('[spin] claim_spin failed:', claimErr);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  if (result.error === 'already_spun') {
    return NextResponse.json({ error: 'already_spun' });
  }
  if (result.error) {
    console.error('[spin] RPC returned error:', result.error);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  // Telegram notification on real (non-test) wins.
  // Awaited (not fire-and-forget) because Vercel serverless terminates the
  // function as soon as the response is sent, which would kill an unawaited fetch.
  // Adds ~200ms on wins only; loss responses are unaffected.
  // Test mode can opt-in with body.notifyTelegram:true to verify the pipe end-to-end.
  const shouldNotify = result.win && (!isTest || body.notifyTelegram === true);
  if (shouldNotify) {
    await sendWinNotification({
      customerId: cleanId,
      prizeAmount: result.prize_amount,
      winsToday: result.wins_today,
      budgetSpent: result.budget_today,
    }).catch(err => console.error('[spin] Telegram notify failed:', err?.message));
  }

  return NextResponse.json({
    win: result.win,
    segmentIndex: result.segment_index,
    prize: result.win ? { kwacha: result.prize_amount } : null,
  });
}
