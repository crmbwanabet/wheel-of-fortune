import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { getWheelDayDate } from '@/lib/algorithms';
import { verifyBwanaToken, TokenError } from '@/lib/bwanaAuth.mjs';
import { reportError } from '@/lib/telemetry';
import { waitUntil } from '@vercel/functions';

// Reports whether the logged-in customer still has today's spin available.
// Mirrors claim_spin's dedupe (customer id OR fingerprint) but read-only —
// the atomic claim in /api/spin remains the source of truth, so this can
// fail open on server errors without risking a double spin.
async function handleStatus(request) {
  // Kill-switch: return immediately without touching the DB (incident relief).
  if (process.env.SPIN_MAINTENANCE === '1') {
    return NextResponse.json({ available: false, maintenance: true });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  let customerId;
  try {
    customerId = verifyBwanaToken(body.token).id;
  } catch (err) {
    const code = err instanceof TokenError && err.code === 'expired' ? 'token_expired' : 'invalid_token';
    return NextResponse.json({ available: false, error: code }, { status: 401 });
  }

  // Fingerprint comes from the client; only trust it as a filter if it looks
  // like our sha-256 hex fingerprints (guards the PostgREST .or() syntax).
  const fingerprint =
    typeof body.fingerprint === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.fingerprint)
      ? body.fingerprint
      : null;

  const dayDate = getWheelDayDate();
  const supabase = getSupabase();

  let query = supabase
    .from('wheel_spin_log')
    .select('customer_id')
    .eq('day_date', dayDate)
    .eq('test_bucket', '')
    .limit(1);
  query = fingerprint
    ? query.or(`customer_id.eq.${customerId},fingerprint.eq.${fingerprint}`)
    : query.eq('customer_id', customerId);

  const { data, error } = await query;
  if (error) {
    console.error('[spin-status] query failed:', error);
    waitUntil(reportError(error, { route: 'spin-status', status: 500, code: 'query_failed' }));
    return NextResponse.json({ available: true }); // fail open — claim_spin still dedupes
  }

  return NextResponse.json({ available: data.length === 0 });
}

export async function POST(request) {
  try {
    return await handleStatus(request);
  } catch (err) {
    waitUntil(reportError(err, { route: 'spin-status', status: 500, code: 'unhandled' }));
    // spin-status fails open — the atomic claim in /api/spin is the source of truth.
    return NextResponse.json({ available: true });
  }
}
