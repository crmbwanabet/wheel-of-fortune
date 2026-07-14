import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { checkRateLimit } from '@/lib/rateLimit';
import { reportError } from '@/lib/telemetry';

export const dynamic = 'force-dynamic';

const MAX_BODY = 4000; // chars; guards against abuse

// Receives client/widget error reports and forwards them to the owner's DM.
// Never touches the wheel database.
export async function POST(request) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  try {
    if (!(await checkRateLimit('telemetry', ip, 10, 60))) {
      return NextResponse.json({ ok: false }, { status: 429 });
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY) {
      return NextResponse.json({ ok: false, error: 'too_large' }, { status: 413 });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }

    const type = typeof body.type === 'string' ? body.type.slice(0, 60) : 'client_error';
    const message = typeof body.message === 'string' ? body.message.slice(0, 500) : 'client error';
    waitUntil(reportError(new Error(message), {
      route: 'widget',
      code: type,
      source: 'widget',
      extra: typeof body.context === 'string' ? body.context.slice(0, 200) : undefined,
    }));
    return NextResponse.json({ ok: true });
  } catch (err) {
    waitUntil(reportError(err, { route: 'telemetry', status: 500, code: 'unhandled' }));
    return NextResponse.json({ ok: false }, { status: 200 }); // never surface errors to the client reporter
  }
}
