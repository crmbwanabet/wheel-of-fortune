import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMO_VARIANTS, PROMO_SITES, DEFAULT_PROMO_VARIANT,
  getPromoVariant, resolvePromoSite, isPromoHost,
} from './promoConfig.js';

test('every configured site is complete', () => {
  for (const [key, site] of Object.entries(PROMO_VARIANTS)) {
    assert.equal(site.variant, key);
    assert.ok(site.host.length > 0, key);
    assert.match(site.path, /^\/[a-z-]+$/, key);
    assert.ok(site.label.length > 0, key);
    assert.match(site.destination, /^https?:\/\//, key);
    assert.ok(site.ctaText.length > 0, key);
    assert.ok(site.subText.length > 0, key);
    assert.ok(site.background.mobile.startsWith('/'), key);
    assert.ok(site.background.desktop.startsWith('/'), key);
  }
});

test('the new-player site carries the affiliate registration link', () => {
  // Resolved form of the A252 short-link: its 301 drops extra query params,
  // and the wof marker must survive for the arrival popup on bwanabet.com.
  assert.equal(PROMO_VARIANTS.new.destination, 'https://bwanabet.com/en/auth/signup?ref_id=A252&wof=new');
  assert.match(PROMO_VARIANTS.existing.destination, /wof=existing/);
});

test('paths and hosts are distinct between sites', () => {
  const sites = Object.values(PROMO_VARIANTS);
  assert.equal(new Set(sites.map((s) => s.path)).size, sites.length);
  assert.equal(new Set(sites.map((s) => s.host)).size, sites.length);
});

test('getPromoVariant resolves known keys and rejects everything else', () => {
  assert.equal(getPromoVariant('new').variant, 'new');
  assert.equal(getPromoVariant('existing').variant, 'existing');
  assert.equal(getPromoVariant('nope'), null);
  assert.equal(getPromoVariant(undefined), null);
  // Inherited object keys must not resolve — the key can come from a request body.
  assert.equal(getPromoVariant('constructor'), null);
  assert.equal(getPromoVariant('__proto__'), null);
});

test('exact host resolves; port and case are ignored', () => {
  const host = Object.keys(PROMO_SITES)[0];
  assert.equal(resolvePromoSite(host).host, host);
  assert.equal(resolvePromoSite(host.toUpperCase() + ':3000').host, host);
  assert.equal(resolvePromoSite(host).fallback, false);
});

test('unknown host falls back to the default site, flagged as fallback', () => {
  const s = resolvePromoSite('wheel-of-fortune-xyz.vercel.app');
  assert.equal(s.variant, DEFAULT_PROMO_VARIANT);
  assert.equal(s.fallback, true);
  assert.equal(resolvePromoSite(undefined).variant, DEFAULT_PROMO_VARIANT);
});

test('isPromoHost is true only for configured hosts', () => {
  assert.equal(isPromoHost(Object.keys(PROMO_SITES)[1]), true);
  assert.equal(isPromoHost('bwanabet-wheel.vercel.app'), false);
  assert.equal(isPromoHost(null), false);
});
