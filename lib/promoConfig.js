// One entry per promo domain. The page, the middleware and the digest all
// read this table — nothing else knows which domain means what.
//
// PLACEHOLDER hosts and links: the owner supplies the real domain names, the
// affiliate registration link (prefills the promo code on BwanaBet's
// registration page) and the login URL. Until then the first entry doubles
// as the preview-deploy fallback so the page renders everywhere.

export const PROMO_SITES = {
  // Domain A — new players → registration via the affiliate link.
  'spin.bwanabet-promo.com': {
    audience: 'new',
    destination: 'https://bwanabet.com/register?promo=PLACEHOLDER_AFFILIATE',
    ctaText: 'Claim your free spins',
    subText: 'Register in under a minute — your 50 Aviator free spins are waiting.',
    background: { mobile: '/promo/bg-new-mobile.svg', desktop: '/promo/bg-new-desktop.svg' },
  },
  // Domain B — existing never-deposited customers → login.
  'bonus.bwanabet-promo.com': {
    audience: 'existing',
    destination: 'https://bwanabet.com/login',
    ctaText: 'Log in to claim',
    subText: 'Your 50 Aviator free spins are already in your account.',
    background: { mobile: '/promo/bg-existing-mobile.svg', desktop: '/promo/bg-existing-desktop.svg' },
  },
};

export const DEFAULT_PROMO_HOST = Object.keys(PROMO_SITES)[0];

function normaliseHost(host) {
  return String(host || '').toLowerCase().split(':')[0];
}

export function isPromoHost(host) {
  return Object.prototype.hasOwnProperty.call(PROMO_SITES, normaliseHost(host));
}

// Always returns a site. `fallback: true` means the host was not configured
// (preview deploy, localhost) and the default entry is being shown.
export function resolvePromoSite(host) {
  const h = normaliseHost(host);
  if (isPromoHost(h)) return { host: h, fallback: false, ...PROMO_SITES[h] };
  return { host: DEFAULT_PROMO_HOST, fallback: true, ...PROMO_SITES[DEFAULT_PROMO_HOST] };
}
