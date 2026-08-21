# Promo Wheel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A free-play promo wheel page that always lands on "50 Aviator Free Spins", shows a big claim popup, and sends the visitor to BwanaBet registration (Domain A, affiliate link) or login (Domain B), with per-domain funnel counts in the daily digest.

**Architecture:** New `/promo` route in this Next.js app; `middleware.js` rewrites `/` → `/promo` on the promo hostnames; `lib/promoConfig.js` keys copy/destination/art by hostname. Pure, tested modules for landing maths (`promoSpin`), config resolution (`promoConfig`) and once-per-visitor storage (`promoOnce`); one client component renders the wheel with CSS conic-gradient and `requestAnimationFrame`. A tiny `/api/promo-event` endpoint writes `view/spin/claim_click` rows to a new `promo_events` table; the digest prints one line per domain.

**Tech Stack:** Next.js 14 app router, React 18, Tailwind (already configured), `node:test`, Supabase (CRM project `blrrcnrhixckfudiojwe`, service_role), Vercel.

**Spec:** `docs/superpowers/specs/2026-08-21-promo-wheel-design.md`

**Conventions:** tests run with `node --test lib/<name>.test.mjs` (`npm test` runs all). Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Branch `feat/promo-wheel` exists with the spec committed.

---

## File map

| File | Responsibility |
|---|---|
| Create `lib/promoSpin.js` + `.test.mjs` | segment table, `landingAngle()`, `SPIN_PHASES`, `angleAt(t)` — pure maths |
| Create `lib/promoConfig.js` + `.test.mjs` | `PROMO_SITES`, `resolvePromoSite(host)`, `isPromoHost(host)` |
| Create `lib/promoOnce.js` + `.test.mjs` | `readPromoSpun(storage)`, `writePromoSpun(storage, nowIso)` |
| Create `middleware.js` | rewrite `/` → `/promo` on promo hosts |
| Create `app/promo/layout.js` | promo metadata (title/description/viewport) |
| Create `app/promo/page.js` | server component: resolves site from `headers().get('host')`, renders `<PromoWheel site=…/>` |
| Create `components/PromoWheel.jsx` | the wheel, SPIN button, popup, event beacons |
| Create `app/promo/promo.css` | keyframes + layout rules (imported by the component) |
| Create `supabase/migrations/2026-08-21-promo-events.sql` | `promo_events` table, RLS, grants |
| Create `app/api/promo-event/route.js` | beacon sink |
| Modify `lib/digestLines.js` + `.test.mjs` | `promoLine(host, counts)` |
| Modify `app/api/digest/route.js` | one promo line per configured host |
| Create `public/promo/` | placeholder `bg-*.svg` until the owner's art arrives |

---

### Task 1: Landing maths (`lib/promoSpin.js`)

**Files:**
- Create: `lib/promoSpin.js`
- Create: `lib/promoSpin.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// lib/promoSpin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMO_SEGMENTS, SEGMENT_DEG, WIN_INDICES, SPIN_PHASES, TOTAL_MS,
  landingAngle, segmentAtPointer, angleAt,
} from './promoSpin.js';

test('ten segments, each outcome twice, alternating', () => {
  assert.equal(PROMO_SEGMENTS.length, 10);
  assert.equal(SEGMENT_DEG, 36);
  const labels = PROMO_SEGMENTS.map((s) => s.id);
  assert.deepEqual(labels.slice(0, 5), labels.slice(5));
  assert.deepEqual(WIN_INDICES, [3, 8]);
  assert.equal(PROMO_SEGMENTS[3].id, 'freespins');
  assert.equal(PROMO_SEGMENTS[8].id, 'freespins');
});

test('landingAngle always resolves to a free-spins segment (1000 samples)', () => {
  for (let i = 0; i < 1000; i++) {
    const a = landingAngle(Math.random);
    assert.ok(WIN_INDICES.includes(segmentAtPointer(a)), `angle ${a} landed on ${segmentAtPointer(a)}`);
  }
});

test('landingAngle stays inside the middle 70% of the slice', () => {
  // rnd=0 → earliest allowed offset, rnd=1 → latest; both must still be the win slice
  const lo = landingAngle(() => 0);
  const hi = landingAngle(() => 0.999999);
  assert.ok(WIN_INDICES.includes(segmentAtPointer(lo)));
  assert.ok(WIN_INDICES.includes(segmentAtPointer(hi)));
  const within = (a) => ((a % SEGMENT_DEG) + SEGMENT_DEG) % SEGMENT_DEG;
  assert.ok(within(lo) >= SEGMENT_DEG * 0.15 - 1e-9);
  assert.ok(within(hi) <= SEGMENT_DEG * 0.85 + 1e-9);
});

test('segmentAtPointer maps a wheel rotation to the slice under the top pointer', () => {
  // Rotation 0 → segment 0 is under the pointer (slices start at 12 o'clock, clockwise).
  assert.equal(segmentAtPointer(0), 0);
  // Rotating the wheel clockwise by one slice brings the LAST slice under the pointer.
  assert.equal(segmentAtPointer(36), 9);
  assert.equal(segmentAtPointer(-36), 1);
  assert.equal(segmentAtPointer(360 * 5), 0);
});

test('phases sum to TOTAL_MS and angleAt is monotonic and ends exactly on target', () => {
  assert.equal(SPIN_PHASES.accel + SPIN_PHASES.cruise + SPIN_PHASES.ease, TOTAL_MS);
  const target = 5 * 360 + 123;
  let prev = -Infinity;
  for (let t = 0; t <= TOTAL_MS; t += 16) {
    const a = angleAt(t, target);
    assert.ok(a >= prev - 1e-9, `non-monotonic at t=${t}`);
    prev = a;
  }
  assert.equal(Math.round(angleAt(TOTAL_MS, target) * 1000) / 1000, target);
  assert.equal(angleAt(TOTAL_MS + 5000, target), target);
  assert.equal(angleAt(0, target), 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test lib/promoSpin.test.mjs`
Expected: FAIL — `Cannot find module './promoSpin.js'`

- [ ] **Step 3: Implement**

```js
// lib/promoSpin.js
// Pure maths for the promo wheel. No DOM. Everything the component needs to
// know about WHERE to stop and HOW the angle evolves over time lives here so
// it can be tested without a browser.

// Slice 0 starts at 12 o'clock and slices run clockwise. Each of the five
// outcomes appears twice so the wheel reads as full.
export const PROMO_SEGMENTS = [
  { id: 'k100',      label: 'K100',           color: '#F5B301', text: '#1A1E2E' },
  { id: 'k20',       label: 'K20',            color: '#1A1E2E', text: '#FFFFFF' },
  { id: 'k50',       label: 'K50',            color: '#C50E1F', text: '#FFFFFF' },
  { id: 'freespins', label: '50 FREE SPINS',  color: '#FEF200', text: '#1A1E2E', win: true },
  { id: 'lose',      label: 'LOSE',           color: '#5B6270', text: '#FFFFFF' },
  { id: 'k100',      label: 'K100',           color: '#F5B301', text: '#1A1E2E' },
  { id: 'k20',       label: 'K20',            color: '#1A1E2E', text: '#FFFFFF' },
  { id: 'k50',       label: 'K50',            color: '#C50E1F', text: '#FFFFFF' },
  { id: 'freespins', label: '50 FREE SPINS',  color: '#FEF200', text: '#1A1E2E', win: true },
  { id: 'lose',      label: 'LOSE',           color: '#5B6270', text: '#FFFFFF' },
];

export const SEGMENT_DEG = 360 / PROMO_SEGMENTS.length;
export const WIN_INDICES = PROMO_SEGMENTS.map((s, i) => (s.win ? i : -1)).filter((i) => i >= 0);

// Which slice sits under the fixed pointer at 12 o'clock when the wheel
// element is rotated by `rotationDeg` clockwise. Slice k occupies
// [k*SEG, (k+1)*SEG) in the wheel's own frame; rotating the wheel clockwise
// by r brings the slice at (-r) under the pointer.
export function segmentAtPointer(rotationDeg) {
  const inWheel = (((-rotationDeg) % 360) + 360) % 360;
  return Math.floor(inWheel / SEGMENT_DEG) % PROMO_SEGMENTS.length;
}

// A final rotation (degrees, clockwise, several full turns included) that
// puts one of the win slices under the pointer, at a random offset inside
// the middle 70% of the slice so the pointer never sits on an edge.
export function landingAngle(rnd = Math.random) {
  const idx = WIN_INDICES[Math.floor(rnd() * WIN_INDICES.length)];
  const offset = SEGMENT_DEG * (0.15 + 0.70 * rnd());      // 5.4° .. 30.6°
  const turns = 5 + Math.floor(rnd() * 2);                  // 5 or 6 full turns
  // The wheel-frame angle we want under the pointer is idx*SEG + offset;
  // rotation r satisfies (-r mod 360) == that, so r = 360 - that (mod 360).
  const base = (360 - (idx * SEGMENT_DEG + offset)) % 360;
  return turns * 360 + base;
}

// Three phases, in ms. accel: 0 → full speed; cruise: full speed; ease:
// cubic ease-out into the target. Kept as a table so the component and the
// tests share one source of truth.
export const SPIN_PHASES = { accel: 900, cruise: 2200, ease: 3200 };
export const TOTAL_MS = SPIN_PHASES.accel + SPIN_PHASES.cruise + SPIN_PHASES.ease;

// Degrees covered during accel + cruise, as a fraction of the target. The
// ease phase then covers the rest. 0.55 makes the final slow-down visibly
// long without the wheel appearing to stall.
const PRE_EASE_SHARE = 0.55;

// Wheel rotation at time t (ms since SPIN) for a given final target angle.
// Monotonic non-decreasing; equals target for t >= TOTAL_MS.
export function angleAt(t, target) {
  if (t <= 0) return 0;
  if (t >= TOTAL_MS) return target;
  const { accel, cruise, ease } = SPIN_PHASES;
  const preEase = target * PRE_EASE_SHARE;
  // Constant-acceleration ramp then constant speed: distance = v*(accel/2 + cruise)
  const v = preEase / (accel / 2 + cruise);              // deg per ms at cruise
  if (t < accel) return 0.5 * v * (t * t) / accel;
  if (t < accel + cruise) return 0.5 * v * accel + v * (t - accel);
  const u = (t - accel - cruise) / ease;                 // 0..1 in ease
  const eased = 1 - Math.pow(1 - u, 3);
  return preEase + (target - preEase) * eased;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test lib/promoSpin.test.mjs`
Expected: 5 passing

- [ ] **Step 5: Commit**

```bash
git add lib/promoSpin.js lib/promoSpin.test.mjs
git commit -m "feat(promo): pure landing/animation maths for the promo wheel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Site config (`lib/promoConfig.js`)

**Files:**
- Create: `lib/promoConfig.js`
- Create: `lib/promoConfig.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// lib/promoConfig.test.mjs
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test lib/promoConfig.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// lib/promoConfig.js
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
    headline: 'Spin to win 50 Aviator Free Spins',
    ctaText: 'Claim your free spins',
    subText: 'Register in under a minute — your 50 Aviator free spins are waiting.',
    background: { mobile: '/promo/bg-new-mobile.svg', desktop: '/promo/bg-new-desktop.svg' },
  },
  // Domain B — existing never-deposited customers → login.
  'bonus.bwanabet-promo.com': {
    audience: 'existing',
    destination: 'https://bwanabet.com/login',
    headline: 'Your 50 Aviator Free Spins are waiting',
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
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test lib/promoConfig.test.mjs`
Expected: 4 passing

- [ ] **Step 5: Commit**

```bash
git add lib/promoConfig.js lib/promoConfig.test.mjs
git commit -m "feat(promo): per-domain site config with preview fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Once-per-visitor storage helper (`lib/promoOnce.js`)

**Files:**
- Create: `lib/promoOnce.js`
- Create: `lib/promoOnce.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// lib/promoOnce.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMO_STORAGE_KEY, readPromoSpun, writePromoSpun } from './promoOnce.js';

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
}

test('fresh storage → not spun', () => {
  assert.equal(readPromoSpun(memStorage()), null);
});

test('write then read round-trips the timestamp', () => {
  const s = memStorage();
  writePromoSpun(s, '2026-08-21T10:00:00.000Z');
  assert.equal(readPromoSpun(s), '2026-08-21T10:00:00.000Z');
  assert.ok(s._m.has(PROMO_STORAGE_KEY));
});

test('corrupt or foreign values read as not spun', () => {
  assert.equal(readPromoSpun(memStorage({ [PROMO_STORAGE_KEY]: 'garbage' })), null);
  assert.equal(readPromoSpun(memStorage({ [PROMO_STORAGE_KEY]: '{"spunAt":42}' })), null);
});

test('a storage that throws is tolerated', () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readPromoSpun(bad), null);
  assert.doesNotThrow(() => writePromoSpun(bad, '2026-08-21T10:00:00.000Z'));
});

test('missing storage (SSR) is tolerated', () => {
  assert.equal(readPromoSpun(null), null);
  assert.doesNotThrow(() => writePromoSpun(undefined, '2026-08-21T10:00:00.000Z'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test lib/promoOnce.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// lib/promoOnce.js
// "One spin per visitor" for the free promo wheel. Device-scoped on purpose:
// there is no login and nothing of value is paid out, so localStorage is the
// right amount of enforcement. Storage is injected so this is testable.
export const PROMO_STORAGE_KEY = 'bb_promo';

// Returns the ISO timestamp of the visitor's spin, or null.
export function readPromoSpun(storage) {
  try {
    const raw = storage && storage.getItem(PROMO_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.spunAt === 'string' && !Number.isNaN(Date.parse(parsed.spunAt))
      ? parsed.spunAt
      : null;
  } catch {
    return null;
  }
}

export function writePromoSpun(storage, nowIso) {
  try {
    if (storage) storage.setItem(PROMO_STORAGE_KEY, JSON.stringify({ spunAt: nowIso }));
  } catch { /* quota / private mode — the visitor just gets another spin */ }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test lib/promoOnce.test.mjs`
Expected: 5 passing

- [ ] **Step 5: Commit**

```bash
git add lib/promoOnce.js lib/promoOnce.test.mjs
git commit -m "feat(promo): once-per-visitor storage helper

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Middleware rewrite for promo hosts

**Files:**
- Create: `middleware.js`

- [ ] **Step 1: Create the middleware**

```js
// middleware.js
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
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles; output lists `ƒ Middleware`.

- [ ] **Step 3: Commit**

```bash
git add middleware.js
git commit -m "feat(promo): rewrite / to /promo on promo hostnames

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Placeholder backgrounds

**Files:**
- Create: `public/promo/bg-new-mobile.svg`, `public/promo/bg-new-desktop.svg`, `public/promo/bg-existing-mobile.svg`, `public/promo/bg-existing-desktop.svg`

- [ ] **Step 1: Create four SVGs.** Same file for mobile/desktop of a domain except the `viewBox`; the owner replaces these with 1080×1920 / 1920×1080 artwork using the same file names (or updates `promoConfig.background`).

`public/promo/bg-new-mobile.svg` (viewBox 1080×1920) and `bg-new-desktop.svg` (viewBox 1920×1080):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="g" cx="50%" cy="50%" r="75%">
      <stop offset="0" stop-color="#2b1d5e"/>
      <stop offset="0.55" stop-color="#150f33"/>
      <stop offset="1" stop-color="#080612"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
</svg>
```

`bg-existing-*.svg`: identical but with stops `#5e1d1d` / `#33100f` / `#120606` (a warm red-black), so the two domains are visibly different while the art is pending.

- [ ] **Step 2: Commit**

```bash
git add public/promo
git commit -m "feat(promo): placeholder backgrounds per domain

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: The promo page

**Files:**
- Create: `app/promo/layout.js`
- Create: `app/promo/page.js`
- Create: `app/promo/promo.css`
- Create: `components/PromoWheel.jsx`

- [ ] **Step 1: Layout with its own metadata**

```js
// app/promo/layout.js
export const metadata = {
  title: 'Spin & Win 50 Aviator Free Spins — BwanaBet',
  description: 'Spin the wheel for free and claim 50 Aviator free spins on BwanaBet.',
};

export const viewport = { width: 'device-width', initialScale: 1, maximumScale: 1 };

export default function PromoLayout({ children }) {
  return children;
}
```

- [ ] **Step 2: Server page resolving the site from the host header**

```js
// app/promo/page.js
import { headers } from 'next/headers';
import { resolvePromoSite } from '@/lib/promoConfig';
import PromoWheel from '@/components/PromoWheel';

export const dynamic = 'force-dynamic';

export default function PromoPage() {
  const site = resolvePromoSite(headers().get('host'));
  return <PromoWheel site={site} />;
}
```

- [ ] **Step 3: Styles**

```css
/* app/promo/promo.css */
.promo-root {
  position: fixed; inset: 0;
  display: grid; place-items: center;
  background-color: #080612;
  background-size: cover; background-position: center;
  color: #fff; text-align: center;
  font-family: var(--font-brand), "Roboto Condensed", sans-serif;
  overflow: hidden;
}
.promo-layout {
  display: grid; gap: 18px; width: min(100vw, 1400px); padding: 24px;
  grid-template-areas: "head" "wheel" "cta" "fine";
  justify-items: center; align-content: center;
}
@media (min-width: 768px) and (orientation: landscape) {
  .promo-layout {
    grid-template-columns: 1fr 1fr;
    grid-template-areas: "wheel head" "wheel cta" "wheel fine";
    align-items: center; gap: 12px 48px; padding: 40px 64px;
  }
  .promo-head, .promo-cta, .promo-fine { justify-self: start; text-align: left; }
}
.promo-head { grid-area: head; font-weight: 900; text-transform: uppercase; letter-spacing: -0.01em;
  font-size: clamp(26px, 6vw, 56px); line-height: 1.02; text-shadow: 0 4px 24px rgba(0,0,0,.6); }
.promo-head b { color: #FEF200; }
.promo-fine { grid-area: fine; font-size: 12px; color: rgba(255,255,255,.65); max-width: 420px; }

/* Wheel */
.promo-wheel-wrap { grid-area: wheel; position: relative; width: min(92vw, 60vh, 640px); aspect-ratio: 1; }
@media (min-width: 768px) and (orientation: landscape) { .promo-wheel-wrap { width: min(44vw, 78vh, 640px); } }
.promo-wheel {
  position: absolute; inset: 0; border-radius: 50%;
  border: 10px solid #FEF200; box-shadow: 0 0 0 6px #1A1E2E, 0 0 60px rgba(254,242,0,.45), inset 0 0 40px rgba(0,0,0,.5);
  will-change: transform;
}
.promo-label {
  position: absolute; left: 50%; top: 50%; transform-origin: 0 0;
  font-weight: 900; text-transform: uppercase; white-space: nowrap;
  font-size: clamp(11px, 2.6vw, 20px); letter-spacing: .02em;
}
@media (min-width: 768px) { .promo-label { font-size: clamp(12px, 1.3vw, 20px); } }
.promo-hub {
  position: absolute; left: 50%; top: 50%; width: 17%; aspect-ratio: 1; transform: translate(-50%, -50%);
  border-radius: 50%; background: radial-gradient(circle at 35% 35%, #fff8a8, #FEF200 45%, #c9a800);
  box-shadow: 0 0 0 5px #1A1E2E, 0 6px 18px rgba(0,0,0,.6); display: grid; place-items: center;
  font-weight: 900; color: #1A1E2E; font-size: clamp(12px, 2.8vw, 22px);
}
.promo-pointer {
  position: absolute; left: 50%; top: -4%; transform: translateX(-50%);
  width: 0; height: 0; border-left: 18px solid transparent; border-right: 18px solid transparent;
  border-top: 44px solid #C50E1F; filter: drop-shadow(0 4px 6px rgba(0,0,0,.6)); z-index: 2;
}
.promo-pointer::after {
  content: ""; position: absolute; left: -10px; top: -50px; width: 20px; height: 20px; border-radius: 50%; background: #C50E1F;
}

/* CTA */
.promo-cta { grid-area: cta; }
.promo-spin-btn {
  appearance: none; border: 0; cursor: pointer; border-radius: 999px;
  padding: 18px 56px; font-weight: 900; text-transform: uppercase; letter-spacing: .08em;
  font-size: clamp(18px, 4.5vw, 26px); color: #1A1E2E;
  background: linear-gradient(135deg, #FEF200, #f0b400);
  box-shadow: 0 8px 30px rgba(254,242,0,.45), inset 0 -4px 0 rgba(0,0,0,.15);
  animation: promoPulse 1.6s ease-in-out infinite;
}
.promo-spin-btn:disabled { animation: none; opacity: .6; cursor: default; }
@keyframes promoPulse { 0%,100% { transform: scale(1);} 50% { transform: scale(1.05);} }

/* Popup */
.promo-scrim { position: fixed; inset: 0; background: rgba(4,2,12,.82); display: grid; place-items: center; z-index: 10;
  animation: promoFade .35s ease-out both; }
@keyframes promoFade { from { opacity: 0 } to { opacity: 1 } }
.promo-modal {
  width: min(92vw, 520px); padding: 36px 28px 30px; border-radius: 24px; text-align: center;
  background: linear-gradient(180deg, #1f1340, #0e0a22);
  border: 2px solid rgba(254,242,0,.55); box-shadow: 0 0 80px rgba(254,242,0,.25), 0 30px 80px rgba(0,0,0,.7);
  animation: promoZoom .5s cubic-bezier(.34,1.56,.64,1) both; position: relative; overflow: hidden;
}
@keyframes promoZoom { from { transform: scale(.7); opacity: 0 } to { transform: scale(1); opacity: 1 } }
.promo-modal h2 { font-size: clamp(28px, 7vw, 44px); font-weight: 900; color: #FEF200; margin: 0 0 8px; text-transform: uppercase; }
.promo-modal p.win { font-size: clamp(18px, 4.6vw, 26px); margin: 0 0 22px; }
.promo-modal p.win b { color: #FEF200; }
.promo-claim {
  display: block; text-decoration: none; color: #1A1E2E; border-radius: 999px; padding: 20px 24px;
  font-weight: 900; text-transform: uppercase; letter-spacing: .06em; font-size: clamp(18px, 5vw, 26px);
  background: linear-gradient(135deg, #FEF200, #f0b400); box-shadow: 0 10px 36px rgba(254,242,0,.5);
  animation: promoPulse 1.2s ease-in-out infinite;
}
.promo-sub { margin: 14px 0 0; font-size: 14px; color: rgba(255,255,255,.75); }
.promo-later { display: inline-block; margin-top: 14px; font-size: 13px; color: rgba(255,255,255,.5); text-decoration: underline; background: none; border: 0; cursor: pointer; }

/* Confetti: 40 absolutely positioned pieces with randomised CSS vars */
.promo-confetti { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.promo-confetti i {
  position: absolute; top: -12px; left: var(--x); width: 10px; height: 16px; background: var(--c);
  transform: rotate(var(--r)); animation: promoDrop var(--d) linear var(--delay) infinite;
}
@keyframes promoDrop { to { transform: translateY(110vh) rotate(calc(var(--r) + 540deg)); } }
```

- [ ] **Step 4: The component**

```jsx
// components/PromoWheel.jsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import '@/app/promo/promo.css';
import { PROMO_SEGMENTS, SEGMENT_DEG, landingAngle, angleAt, TOTAL_MS } from '@/lib/promoSpin';
import { readPromoSpun, writePromoSpun } from '@/lib/promoOnce';

// Build the conic-gradient once: slice k = [k*SEG, (k+1)*SEG), starting at 12 o'clock.
const WHEEL_GRADIENT = `conic-gradient(from 0deg, ${PROMO_SEGMENTS
  .map((s, i) => `${s.color} ${i * SEGMENT_DEG}deg ${(i + 1) * SEGMENT_DEG}deg`)
  .join(', ')})`;

const CONFETTI_COLORS = ['#FEF200', '#C50E1F', '#ffffff', '#F5B301', '#3ddc84'];

function sendEvent(event) {
  try {
    const body = JSON.stringify({ event, isMobile: window.matchMedia('(max-width: 767px), (orientation: portrait)').matches });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/promo-event', new Blob([body], { type: 'application/json' }));
    } else {
      fetch('/api/promo-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch { /* never break the page over analytics */ }
}

function Confetti() {
  const pieces = Array.from({ length: 40 }, (_, i) => ({
    x: `${(i * 37) % 100}%`,
    c: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    r: `${(i * 53) % 360}deg`,
    d: `${2.4 + (i % 5) * 0.35}s`,
    delay: `${(i % 8) * 0.15}s`,
  }));
  return (
    <div className="promo-confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <i key={i} style={{ '--x': p.x, '--c': p.c, '--r': p.r, '--d': p.d, '--delay': p.delay }} />
      ))}
    </div>
  );
}

export default function PromoWheel({ site }) {
  // idle → spinning → result
  const [screen, setScreen] = useState('idle');
  const [isMobile, setIsMobile] = useState(true);
  const wheelRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px), (orientation: portrait)');
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Returning visitor: they already won — go straight to the claim.
  useEffect(() => {
    sendEvent('view');
    if (readPromoSpun(window.localStorage)) setScreen('result');
  }, []);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  const spin = useCallback(() => {
    if (screen !== 'idle') return;
    setScreen('spinning');
    writePromoSpun(window.localStorage, new Date().toISOString());
    sendEvent('spin');
    const target = landingAngle();
    const start = performance.now();
    const frame = (now) => {
      const t = now - start;
      const a = angleAt(t, target);
      if (wheelRef.current) wheelRef.current.style.transform = `rotate(${a}deg)`;
      if (t < TOTAL_MS) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        // Short beat so the pointer is seen resting on the slice before the popup.
        setTimeout(() => setScreen('result'), 650);
      }
    };
    rafRef.current = requestAnimationFrame(frame);
  }, [screen]);

  const bg = isMobile ? site.background.mobile : site.background.desktop;
  const labelRadius = 0.33; // fraction of wheel width from centre to label anchor

  return (
    <main className="promo-root" style={{ backgroundImage: `url(${bg})` }}>
      <div className="promo-layout">
        <h1 className="promo-head">
          {site.audience === 'new'
            ? <>Spin to win <b>50 Aviator Free Spins</b></>
            : <>Your <b>50 Aviator Free Spins</b> are waiting</>}
        </h1>

        <div className="promo-wheel-wrap" aria-label="Prize wheel">
          <div className="promo-pointer" />
          <div className="promo-wheel" ref={wheelRef} style={{ background: WHEEL_GRADIENT }}>
            {PROMO_SEGMENTS.map((s, i) => {
              // Place each label along the slice's bisector, text reading outward.
              const mid = i * SEGMENT_DEG + SEGMENT_DEG / 2;
              return (
                <span
                  key={i}
                  className="promo-label"
                  style={{
                    color: s.text,
                    transform: `rotate(${mid - 90}deg) translate(${labelRadius * 100}%, -50%)`,
                    // translate percentage is of the label's own box; use wheel-relative via padding-left trick:
                    paddingLeft: `calc(${labelRadius} * var(--wheel, 0px))`,
                  }}
                >
                  {s.label}
                </span>
              );
            })}
            <div className="promo-hub">SPIN</div>
          </div>
        </div>

        <div className="promo-cta">
          <button type="button" className="promo-spin-btn" onClick={spin} disabled={screen !== 'idle'}>
            {screen === 'spinning' ? 'Spinning…' : 'Spin now'}
          </button>
        </div>
        <p className="promo-fine">Free to play. One spin per visitor. 18+. T&amp;Cs apply.</p>
      </div>

      {screen === 'result' && (
        <div className="promo-scrim" role="dialog" aria-modal="true" aria-labelledby="promo-congrats">
          <div className="promo-modal">
            <Confetti />
            <h2 id="promo-congrats">🎉 Congratulations!</h2>
            <p className="win">You&apos;ve won <b>50 Aviator Free Spins</b></p>
            <a className="promo-claim" href={site.destination} onClick={() => sendEvent('claim_click')}>
              {site.ctaText}
            </a>
            <p className="promo-sub">{site.subText}</p>
            {site.audience === 'existing' && (
              <button type="button" className="promo-later" onClick={() => setScreen('done')}>Maybe later</button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
```

**Label placement note.** The `paddingLeft: calc(… var(--wheel))` trick needs `--wheel` set to the wheel's pixel width. Add to the wheel wrapper a `ref` + `ResizeObserver` that sets the CSS variable, by inserting after the `isMobile` effect:

```jsx
  const wrapRef = useRef(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const set = () => el.style.setProperty('--wheel', `${el.clientWidth}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
```

and put `ref={wrapRef}` on the `<div className="promo-wheel-wrap">`. With that, each label is anchored at the wheel centre, rotated to its slice's bisector, and pushed outward by 33 % of the wheel width — the same approach the money wheel uses for its slice text.

- [ ] **Step 5: Build and eyeball**

Run: `npm run build`
Expected: compiles; `ƒ /promo` in the route list.

Run: `npm run dev` in the background, then open `http://localhost:3000/promo` with the Chrome tools (load `mcp__claude-in-chrome__*` via ToolSearch first):
1. Desktop 1440×900: wheel left, copy right, SPIN pulses.
2. Mobile emulation 390×844: wheel centred, SPIN below, no horizontal scroll.
3. Click SPIN → accelerates, cruises, eases out, pointer rests on a **50 FREE SPINS** slice, popup appears ~0.65 s later with confetti and the pulsing claim button pointing at `site.destination`.
4. Reload → popup immediately (once-per-visitor).
5. `localStorage.removeItem('bb_promo')` and reload → idle again.

Fix anything that looks off before committing; this is the only visual check in the plan.

- [ ] **Step 6: Commit**

```bash
git add app/promo components/PromoWheel.jsx
git commit -m "feat(promo): /promo page — conic wheel, always-win spin, claim popup

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `promo_events` table + beacon endpoint

**Files:**
- Create: `supabase/migrations/2026-08-21-promo-events.sql`
- Create: `app/api/promo-event/route.js`

- [ ] **Step 1: Migration**

```sql
-- Promo wheel funnel events. One row per view / spin / claim_click.
-- Security posture mirrors the wheel tables: RLS on, no policies, service_role only.
BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.promo_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  host        text        NOT NULL,
  event       text        NOT NULL CHECK (event IN ('view', 'spin', 'claim_click')),
  is_mobile   boolean,
  ua          text
);
CREATE INDEX IF NOT EXISTS promo_events_host_time_idx ON public.promo_events (host, created_at DESC);

ALTER TABLE public.promo_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.promo_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.promo_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.promo_events_id_seq TO service_role;

COMMIT;
```

- [ ] **Step 2: Apply it** with `mcp__claude_ai_Supabase__apply_migration` (project `blrrcnrhixckfudiojwe`, name `promo_events`, body without the `BEGIN`/`SET LOCAL`/`COMMIT` lines). Verify:

```sql
select count(*) from information_schema.tables where table_name='promo_events';
```
Expected: 1.

- [ ] **Step 3: Endpoint**

```js
// app/api/promo-event/route.js
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSupabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rateLimit';
import { reportError } from '@/lib/telemetry';
import { resolvePromoSite } from '@/lib/promoConfig';

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

    const site = resolvePromoSite(request.headers.get('host'));
    const { error } = await getSupabase().from('promo_events').insert({
      host: site.fallback ? `preview:${String(request.headers.get('host') || '').slice(0, 80)}` : site.host,
      event: body.event,
      is_mobile: typeof body.isMobile === 'boolean' ? body.isMobile : null,
      ua: String(request.headers.get('user-agent') || '').slice(0, 200) || null,
    });
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
```

- [ ] **Step 4: Build, then commit**

Run: `npm run build` — expect `ƒ /api/promo-event`.

```bash
git add supabase/migrations/2026-08-21-promo-events.sql app/api/promo-event/route.js
git commit -m "feat(promo): promo_events table and beacon endpoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Digest line per promo domain

**Files:**
- Modify: `lib/digestLines.js`, `lib/digestLines.test.mjs`
- Modify: `app/api/digest/route.js`

- [ ] **Step 1: Failing test** (append to `lib/digestLines.test.mjs`; add `promoLine` to the import)

```js
test('promoLine formats the funnel for one host and hides an idle host', () => {
  assert.equal(promoLine('spin.example.com', { view: 412, spin: 380, claim_click: 291 }),
    'Promo spin.example.com: 412 views · 380 spins · 291 claims');
  assert.equal(promoLine('spin.example.com', { view: 0, spin: 0, claim_click: 0 }), null);
  assert.equal(promoLine('spin.example.com', {}), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test lib/digestLines.test.mjs` — expect `promoLine is not a function` / import failure.

- [ ] **Step 3: Implement** (append to `lib/digestLines.js`)

```js
// One funnel line per promo domain. Null when the domain saw nothing — an
// unlaunched domain should not add noise to the digest.
export function promoLine(host, counts = {}) {
  const v = Number(counts.view) || 0;
  const s = Number(counts.spin) || 0;
  const c = Number(counts.claim_click) || 0;
  if (v + s + c === 0) return null;
  return `Promo ${host}: ${v} views · ${s} spins · ${c} claims`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test lib/digestLines.test.mjs` — all passing.

- [ ] **Step 5: Digest route** — add imports and a block that appends promo lines for the reported wheel-day (07:00 UTC boundaries, matching the wheel-day the rest of the digest covers).

Imports:

```js
import { lossesLine, winsSeenLine, potExhausted, LOSS_REASONS, promoLine } from '@/lib/digestLines';
import { PROMO_SITES } from '@/lib/promoConfig';
```

Inside the `try`, immediately before `lines.push(\`(errors delivered live; see alerts)\`);` (and also covering the `spins === 0` branch — so place the promo block **after** the `if/else` that sets `text`, still inside the `try`, rebuilding `text`):

```js
    // Promo funnel, per configured domain, for the same wheel-day window.
    const dayStart = new Date(`${day}T07:00:00Z`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const promoLines = [];
    for (const host of Object.keys(PROMO_SITES)) {
      const counts = {};
      for (const ev of ['view', 'spin', 'claim_click']) {
        const { count, error } = await supabase
          .from('promo_events')
          .select('id', { count: 'exact', head: true })
          .eq('host', host).eq('event', ev)
          .gte('created_at', dayStart.toISOString()).lt('created_at', dayEnd.toISOString());
        if (error) throw error;
        counts[ev] = count ?? 0;
      }
      const pl = promoLine(host, counts);
      if (pl) promoLines.push(pl);
    }
    if (promoLines.length) text = `${text}\n${promoLines.join('\n')}`;
```

- [ ] **Step 6: Build and commit**

Run: `npm run build` — compiles.

```bash
git add lib/digestLines.js lib/digestLines.test.mjs app/api/digest/route.js
git commit -m "feat(digest): promo funnel line per domain

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Finish

- [ ] **Step 1:** `npm test` — all passing (expect the previous 220 + 15 new).
- [ ] **Step 2:** Merge to `main` with `--no-ff` (`merge: promo wheel — free-play acquisition pages`), push, delete the branch.
- [ ] **Step 3:** Verify on the production URL: `https://<vercel-domain>/promo` renders the fallback (Domain A) site on desktop and a phone; one spin lands on FREE SPINS; `promo_events` gets `view`/`spin`/`claim_click` rows with host `preview:<vercel-domain>`.
- [ ] **Step 4:** Report to the owner what is still theirs to supply: the two domain names (to be added to `PROMO_SITES` **and** attached to the Vercel project), the affiliate registration link, the login URL if different from `https://bwanabet.com/login`, and the four background images at 1080×1920 / 1920×1080 (drop into `public/promo/` with the configured names).
- [ ] **Step 5:** Add a memory note: promo wheel exists at `/promo`, config in `lib/promoConfig.js`, placeholders pending from the owner.
