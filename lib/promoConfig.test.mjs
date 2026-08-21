import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMO_SITES, DEFAULT_PROMO_HOST, resolvePromoSite, isPromoHost } from './promoConfig.js';

test('every configured site is complete', () => {
  for (const [host, site] of Object.entries(PROMO_SITES)) {
    assert.ok(host.length > 0);
    assert.ok(['new', 'existing'].includes(site.audience), host);
    assert.match(site.destination, /^https?:\/\//, host);
    assert.ok(site.ctaText.length > 0, host);
    assert.ok(site.subText.length > 0, host);
    assert.ok(site.background.mobile.startsWith('/'), host);
    assert.ok(site.background.desktop.startsWith('/'), host);
  }
});

test('exact host resolves; port and case are ignored', () => {
  const host = Object.keys(PROMO_SITES)[0];
  assert.equal(resolvePromoSite(host).host, host);
  assert.equal(resolvePromoSite(host.toUpperCase() + ':3000').host, host);
  assert.equal(resolvePromoSite(host).fallback, false);
});

test('unknown host falls back to the default site, flagged as fallback', () => {
  const s = resolvePromoSite('wheel-of-fortune-xyz.vercel.app');
  assert.equal(s.host, DEFAULT_PROMO_HOST);
  assert.equal(s.fallback, true);
  assert.equal(resolvePromoSite(undefined).host, DEFAULT_PROMO_HOST);
});

test('isPromoHost is true only for configured hosts', () => {
  assert.equal(isPromoHost(Object.keys(PROMO_SITES)[1]), true);
  assert.equal(isPromoHost('bwanabet-wheel.vercel.app'), false);
  assert.equal(isPromoHost(null), false);
});
