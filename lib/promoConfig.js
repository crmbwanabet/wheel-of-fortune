// One entry per promo site, keyed by a stable variant id. The pages, the
// middleware, the beacon and the digest all read this table — nothing else
// knows which site means what.
//
// Each site is reachable two ways:
//   - its path link (/spin, /bonus) on the main deployment — live today;
//   - its own domain, once the owner provides the real names. The `host`
//     values below are PLACEHOLDERS until then; the first entry doubles as
//     the fallback so the /promo page renders on previews and localhost.

export const PROMO_VARIANTS = {
  // New players → registration with the affiliate code prefilled.
  new: {
    variant: 'new',
    host: 'spin.bwanabet-promo.com',
    path: '/spin',
    label: 'new players',
    destination: 'https://bwanabet.com/en/auth/signup/A252',
    ctaText: 'Claim your free spins',
    subText: 'Register in under a minute — your 50 Aviator free spins are waiting.',
    background: { mobile: '/promo/bg-new-mobile.svg', desktop: '/promo/bg-new-desktop.svg' },
  },
  // Existing never-deposited customers → login.
  existing: {
    variant: 'existing',
    host: 'bonus.bwanabet-promo.com',
    path: '/bonus',
    label: 'existing players',
    destination: 'https://bwanabet.com/en/auth/login',
    ctaText: 'Log in to claim',
    subText: 'Your 50 Aviator free spins are already in your account.',
    background: { mobile: '/promo/bg-existing-mobile.svg', desktop: '/promo/bg-existing-desktop.svg' },
  },
};

export const DEFAULT_PROMO_VARIANT = 'new';

// Same sites keyed by domain, for host-based resolution.
export const PROMO_SITES = Object.fromEntries(
  Object.values(PROMO_VARIANTS).map((site) => [site.host, site])
);

// hasOwnProperty guard: `key` can come from a request body, and inherited
// keys ("constructor", "__proto__") must not resolve to a site.
export function getPromoVariant(key) {
  return Object.prototype.hasOwnProperty.call(PROMO_VARIANTS, key) ? PROMO_VARIANTS[key] : null;
}

function normaliseHost(host) {
  return String(host || '').toLowerCase().split(':')[0];
}

export function isPromoHost(host) {
  return Object.prototype.hasOwnProperty.call(PROMO_SITES, normaliseHost(host));
}

// Always returns a site. `fallback: true` means the host was not configured
// (preview deploy, localhost, the path links) and the default entry is shown.
export function resolvePromoSite(host) {
  const h = normaliseHost(host);
  if (isPromoHost(h)) return { fallback: false, ...PROMO_SITES[h] };
  return { fallback: true, ...PROMO_VARIANTS[DEFAULT_PROMO_VARIANT] };
}
