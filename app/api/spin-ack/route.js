import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSupabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rateLimit';
import { getWheelDayDate } from '@/lib/algorithms';
import { verifyBwanaToken } from '@/lib/bwanaAuth.mjs';
import { reportError } from '@/lib/telemetry';

export const preferredRegion = ['dub1'];
export const dynamic = 'force-dynamic';

// The widget calls this the moment the result card renders. It is the only
// evidence the server has that a spin's outcome reached the player's eyes.
//
// Constant response on purpose: whether or not a row matched, {ok:true}. The
// endpoint must not be an oracle for "has this customer spun today". It writes
// one timestamp to the caller's own row and nothing else.
export async function POST(request) {
  try {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!(await checkRateLimit('spin-ack', ip, 30, 60))) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
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
    } catch {
      // Not reported: /api/spin already reported this token if it was invalid.
      return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
    }

    const { error } = await getSupabase()
      .from('wheel_spin_log')
      .update({ result_seen_at: new Date().toISOString() })
      .eq('day_date', getWheelDayDate())
      .eq('test_bucket', '')
      .eq('customer_id', customerId)
      .is('result_seen_at', null);
    if (error) {
      waitUntil(reportError(error, { route: 'spin-ack', status: 500, code: 'ack_failed', customerId }));
      return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    waitUntil(reportError(err, { route: 'spin-ack', status: 500, code: 'unhandled' }));
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
