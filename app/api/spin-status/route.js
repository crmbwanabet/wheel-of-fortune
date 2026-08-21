import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { getWheelDayDate } from '@/lib/algorithms';
import { verifyBwanaToken, TokenError } from '@/lib/bwanaAuth.mjs';
import { reportError } from '@/lib/telemetry';
import { waitUntil } from '@vercel/functions';

const MINCOUNT_TOKEN = Number(process.env.TELEMETRY_MINCOUNT_TOKEN) || 10;

// Reports whether the logged-in customer still has today's spin available.
// Dedupes on customer id only (read-only) — the atomic claim in /api/spin
// remains the source of truth, so this can fail open on server errors
// without risking a double spin.
async function handleStatus(request) {
  // Kill-switch: return immediately without touching the DB (incident relief).
  if (process.env.SPIN_MAINTENANCE === '1') {
    return NextResponse.json({ available: false, maintenance: true, reason: 'maintenance' });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body', reason: 'invalid_body' }, { status: 400 });
  }

  let customerId;
  try {
    customerId = verifyBwanaToken(body.token).id;
  } catch (err) {
    const code = err instanceof TokenError && err.code === 'expired' ? 'token_expired' : 'invalid_token';
    if (code === 'invalid_token') {
      waitUntil(reportError(err, { route: 'spin-status', status: 401, code: 'invalid_token', minCount: MINCOUNT_TOKEN }));
    }
    return NextResponse.json({ available: false, error: code, reason: code }, { status: 401 });
  }

  const dayDate = getWheelDayDate();
  const supabase = getSupabase();

  // Dedupe on the customer only — NOT the device fingerprint — so multiple
  // accounts can share one computer. Anti-farming is handled by the deposit
  // gate. `fingerprint` is still accepted (and logged at spin time) but no
  // longer gates availability.
  // The outcome columns are selected so a widget whose /api/spin response was
  // lost in flight can recover what actually happened instead of inventing it.
  // Ordered newest-first: dedup means there should only ever be one row, and if
  // that ever stops being true the latest is the one the customer just played.
  const query = supabase
    .from('wheel_spin_log')
    .select('customer_id, won, prize_amount, segment_index')
    .eq('day_date', dayDate)
    .eq('test_bucket', '')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(1);

  const { data, error } = await query;
  if (error) {
    console.error('[spin-status] query failed:', error);
    waitUntil(reportError(error, { route: 'spin-status', status: 500, code: 'query_failed' }));
    // Fail open — claim_spin still dedupes. `check_failed` is deliberately NOT
    // a sticky reason: a DB hiccup must not suppress the wheel for the day.
    return NextResponse.json({ available: true, reason: 'check_failed' });
  }

  const available = data.length === 0;
  if (available) return NextResponse.json({ available: true, reason: 'available' });

  // Attach the committed outcome. This is the customer's own spin, read behind
  // their verified token, so there is nothing here they are not entitled to —
  // and without it a widget that lost the /api/spin response has no way to tell
  // a win from a loss, which is exactly how a real win gets shown as a loss.
  const row = data[0];
  return NextResponse.json({
    available: false,
    reason: 'already_spun',
    result: {
      segmentIndex: row.segment_index,
      won: row.won === true,
      prizeAmount: Number(row.prize_amount) || 0,
    },
  });
}

export async function POST(request) {
  try {
    return await handleStatus(request);
  } catch (err) {
    waitUntil(reportError(err, { route: 'spin-status', status: 500, code: 'unhandled' }));
    // spin-status fails open — the atomic claim in /api/spin is the source of truth.
    return NextResponse.json({ available: true, reason: 'check_failed' });
  }
}
