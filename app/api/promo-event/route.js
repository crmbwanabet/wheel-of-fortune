import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSupabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rateLimit';
import { reportError } from '@/lib/telemetry';
import { resolvePromoSite, getPromoVariant } from '@/lib/promoConfig';

export const dynamic = 'force-dynamic';

const EVENTS = new Set(['view', 'spin', 'claim_click']);

// Beacon sink for the promo funnel. Host comes from the request, never the
// body, so a visitor cannot attribute events to the other domain.
export async function POST(request) {
  try {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!(await checkRateLimit('promo-event', ip, 30, 60))) {
      return NextResponse.json({ ok: false }, { status: 429 });
    }
    let body;
    try { body = await request.json(); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }
    if (!EVENTS.has(body?.event)) return NextResponse.json({ ok: false }, { status: 400 });

    const rawHost = String(request.headers.get('host') || '');
    const site = resolvePromoSite(rawHost);
    // Variant: a configured promo domain is authoritative (Host can't be
    // spoofed cross-domain). On any other host — the path links, previews —
    // the body names which site was showing.
    const bodyVariant = getPromoVariant(body.variant) ? body.variant : null;
    const row = {
      host: site.fallback ? `preview:${rawHost.toLowerCase().split(':')[0].slice(0, 80)}` : site.host,
      variant: site.fallback ? bodyVariant : site.variant,
      event: body.event,
      is_mobile: typeof body.isMobile === 'boolean' ? body.isMobile : null,
      ua: String(request.headers.get('user-agent') || '').slice(0, 200) || null,
    };
    let { error } = await getSupabase().from('promo_events').insert(row);
    if (error && (error.code === 'PGRST204' || /variant/i.test(error.message || ''))) {
      // The variant column's migration hasn't been applied yet — keep the
      // event rather than losing it. Attribution starts once it lands.
      const { variant, ...legacy } = row;
      ({ error } = await getSupabase().from('promo_events').insert(legacy));
    }
    if (error) {
      waitUntil(reportError(error, { route: 'promo-event', status: 500, code: 'insert_failed' }));
      return NextResponse.json({ ok: false }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    waitUntil(reportError(err, { route: 'promo-event', status: 500, code: 'unhandled' }));
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
