// On a promo domain, `/` IS the promo page. Everything else (the money wheel's
// iframe on *.vercel.app, /api/*, static files) is untouched — the matcher
// only fires for the bare root path.
import { NextResponse } from 'next/server';
import { isPromoHost } from './lib/promoConfig.js';

export function middleware(request) {
  if (isPromoHost(request.headers.get('host'))) {
    const url = request.nextUrl.clone();
    url.pathname = '/promo';
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/'] };
