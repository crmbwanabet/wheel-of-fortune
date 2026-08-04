import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { getWheelDayDate } from '@/lib/algorithms';
import { verifyBwanaToken, TokenError } from '@/lib/bwanaAuth.mjs';
import { reportError } from '@/lib/telemetry';
import { waitUntil } from '@vercel/functions';

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
    return NextResponse.json({ available: false, error: code, reason: code }, { status: 401 });
  }

  const dayDate = getWheelDayDate();
  const supabase = getSupabase();

  // Dedupe on the customer only — NOT the device fingerprint — so multiple
  // accounts can share one computer. Anti-farming is handled by the deposit
  // gate. `fingerprint` is still accepted (and logged at spin time) but no
  // longer gates availability.
  const query = supabase
    .from('wheel_spin_log')
    .select('customer_id')
    .eq('day_date', dayDate)
    .eq('test_bucket', '')
    .eq('customer_id', customerId)
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
  return NextResponse.json({ available, reason: available ? 'available' : 'already_spun' });
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
