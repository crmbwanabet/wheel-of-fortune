# Win Cooldown + Widget Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make wheel-visibility failures diagnosable, stop transient server failures from suppressing the wheel for a whole day, and guarantee that a customer who wins cannot win again for 3 wheel-days — passing the intercepted prize to another qualifying player.

**Architecture:** Three independent workstreams shipped in order. W1 (Tasks 1) adds opt-in diagnostics to `embed.js`. W2 (Tasks 2–5) introduces a `sticky` flag so only a genuine "already spun" verdict is written to localStorage, plus a timeout on the availability check. W3 (Tasks 6–11) enforces the cooldown inside the `claim_spin` Postgres function — zero extra round trips, and the lookup only runs on the ~1% of spins that land on a winning position. Cooldown-blocked prizes queue on `wheel_daily_state.carryover_prizes` and are awarded to the next qualifying spinner.

**Tech Stack:** Next.js 14 (App Router, JS not TS), Supabase/Postgres (plpgsql RPC), `node --test` with `node:assert/strict`, vanilla ES5 for `public/embed.js` (it runs on the BwanaBet host page and must stay dependency-free).

**Spec:** `docs/superpowers/specs/2026-08-04-win-cooldown-and-widget-visibility-design.md`

---

## Background you need before starting

**The wheel-day.** The wheel resets at 06:00 CAT = 04:00 UTC. `getWheelDayDate()` in `lib/algorithms.js` returns the current wheel-day as a `'YYYY-MM-DD'` string. All day arithmetic is UTC-based; server local time is never trusted.

**How the widget becomes visible.** `public/embed.js` runs on the BwanaBet page. It polls the `token` cookie every 2s, and once a valid session appears it injects a hidden trigger button plus a hidden iframe pointing at the widget. The widget posts `bwanabet-wheel-ready`, embed replies with the auth token, the widget asks `/api/spin-status` whether a spin is available, and posts `bwanabet-wheel-available`. **Only then** does the button become visible. Any break in that chain means no wheel.

**The two localStorage caches** (different keys, both keyed by customer id):
- `bwanabet_wheel_spun` — written by `embed.js` on the host page.
- `bwanabet_wheel_spin` — written by the widget inside the iframe, via `lib/spunCache.mjs`.

**The production database is shared with the CRM.** 60 connections, 2 vCPU. A prior load test caused a CRM outage. Do **not** load-test it. The verification script in Task 10 writes tens of rows to a dedicated `test_bucket`, which is safe.

**Module format.** `package.json` has no `"type": "module"`. Files in `lib/` use ESM syntax anyway; Node reparses them as ESM (with a warning) and the test suite passes. Follow the existing pattern: implementation in `.js`, tests in `.test.mjs`.

**Test command.** `npm test` runs `node --test lib/*.test.mjs`. Baseline is **71 passing tests**.

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `lib/cooldown.js` | Create | Pure wheel-day arithmetic for the cooldown window; mirrors the SQL. Also parses `SPIN_COOLDOWN_DAYS`. |
| `lib/cooldown.test.mjs` | Create | Boundary tests for the cooldown window and env parsing. |
| `lib/availability.mjs` | Create | Pure decision: given a `/api/spin-status` response, is the wheel available and is that verdict sticky? |
| `lib/availability.test.mjs` | Create | One test per response shape. |
| `public/embed.js` | Modify | Debug logging; sticky-gated `markSpun`; iframe-never-ready telemetry. |
| `app/api/spin-status/route.js` | Modify | Return a `reason` on every response path. |
| `components/WheelWidget.jsx` | Modify | Use `decideAvailability`; add a 4s timeout to the availability fetch; forward `sticky`. |
| `supabase/migrations/2026-08-04-win-cooldown-columns.sql` | Create | Columns + partial index. **Not** transaction-wrapped (`CREATE INDEX CONCURRENTLY`). |
| `supabase/migrations/2026-08-04-win-cooldown-rpc.sql` | Create | `claim_spin` swap, transaction-wrapped. |
| `app/api/spin/route.js` | Modify | Pass `p_cooldown_days` from `SPIN_COOLDOWN_DAYS`. |
| `app/api/digest/route.js` | Modify | Report cooldown blocks and carry-over awards. |
| `scripts/cooldown-verify.mjs` | Create | End-to-end SQL verification against a test bucket. |
| `.env.example` | Modify | Document `SPIN_COOLDOWN_DAYS`. |

---

## Task 1: Diagnostics in embed.js (W1)

Ships first — it is what lets the team member's report actually be diagnosed.

**Files:**
- Modify: `public/embed.js`

- [ ] **Step 1: Add the debug helper**

At the top of the IIFE in `public/embed.js`, immediately after the `var WIDGET_ORIGIN = ...` block (around line 11), insert:

```javascript
  // Opt-in diagnostics. Set window.BWANABET_WHEEL_DEBUG = true in the console,
  // then reload, to see exactly which gate stops the wheel from appearing.
  // Inert (zero cost) unless the flag is set.
  function dbg() {
    if (!window.BWANABET_WHEEL_DEBUG) return;
    try {
      var args = ['[wheel]'].concat(Array.prototype.slice.call(arguments));
      console.log.apply(console, args);
    } catch (e) { /* never break the host page */ }
  }
```

- [ ] **Step 2: Log the token gate**

Replace the whole `readValidToken` function (currently lines 15–27) with:

```javascript
  function readValidToken() {
    try {
      var m = document.cookie.match(/(?:^|;\s*)token=([^;]+)/);
      if (!m) { dbg('no `token` cookie on', location.host, '- user is logged out, or the cookie is HttpOnly / on another domain'); return null; }
      var raw = decodeURIComponent(m[1]);
      var parts = raw.split('.');
      if (parts.length !== 3) { dbg('token cookie is not a 3-part JWT'); return null; }
      var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (!payload || typeof payload.exp !== 'number') { dbg('token has no numeric exp claim'); return null; }
      if (payload.exp * 1000 <= Date.now()) {
        // Printing both sides makes device clock skew obvious: if the device
        // clock runs ahead, a perfectly valid session reads as expired here.
        dbg('token looks EXPIRED. exp=', new Date(payload.exp * 1000).toISOString(),
            'device clock=', new Date().toISOString(),
            '- if the device clock is wrong, fix the clock, not the wheel');
        return null;
      }
      dbg('valid token, expires', new Date(payload.exp * 1000).toISOString());
      return raw;
    } catch (e) { dbg('token read threw:', e && e.message); return null; }
  }
```

- [ ] **Step 3: Log the already-spun gate and widget lifecycle**

In `syncToAccount` (currently lines 262–278), replace the body with:

```javascript
  function syncToAccount(token) {
    var id = customerIdFromToken(token);
    if (!id) { dbg('token has no `id` claim - cannot key the wheel to an account'); return; }
    if (id === activeCustomerId) return; // no account change
    dbg('active account is now', id);
    activeToken = token;
    activeCustomerId = id;
    if (!initialized) {
      if (hasSpunToday(id)) { dbg('account', id, 'already spun on this browser today - wheel stays hidden until 06:00 CAT'); return; }
      dbg('building widget for', id);
      initWidget();                             // build the widget once
      // The freshly-mounted iframe posts 'bwanabet-wheel-ready' → sendAuth().
    } else {
      // Account switched in place: re-point auth and re-run availability.
      dbg('account switched in place - re-keying widget to', id);
      widgetApi.closeWidget();
      widgetApi.hideButton();
      if (hasSpunToday(id)) { dbg('account', id, 'already spun on this browser today'); return; }
      widgetApi.reload();                       // re-mount iframe → ready → sendAuth(new token)
    }
  }
```

- [ ] **Step 4: Log the message handshake**

Inside the `window.addEventListener('message', ...)` handler in `initWidget` (currently starting line 228), add a `dbg` to the `wheel-ready` branch. Replace:

```javascript
      if (e.data.type === 'bwanabet-wheel-ready') {
        sendAuth();
      }
```

with:

```javascript
      if (e.data.type === 'bwanabet-wheel-ready') {
        dbg('widget signalled ready - sending auth');
        sendAuth();
      }
```

And add a log to the availability branch. Replace:

```javascript
      if (e.data.type === 'bwanabet-wheel-available') {
        if (e.data.available) {
          btn.style.display = 'flex';
        } else {
```

with:

```javascript
      if (e.data.type === 'bwanabet-wheel-available') {
        dbg('availability verdict:', JSON.stringify(e.data));
        if (e.data.available) {
          btn.style.display = 'flex';
        } else {
```

(The rest of that branch is rewritten in Task 5 — leave it alone for now.)

- [ ] **Step 5: Allowlist the `www.` origins defensively**

A non-allowlisted host origin is failure cause 3 in the spec: the widget silently
drops the auth token, never runs its availability check, and the button never
appears. `www.bwanabet.com` currently redirects to the apex so it is not hitting
this today, but the cost of covering it is one line.

In `components/WheelWidget.jsx`, replace the `ALLOWED_AUTH_ORIGINS` set (lines 34–40) with:

```javascript
const ALLOWED_AUTH_ORIGINS = new Set([
  'https://bwanabet.com',
  'https://bwanabet.co.zm',
  // `www.` variants: www.bwanabet.com currently 301s to the apex and
  // www.bwanabet.co.zm 404s, but if either ever serves the site directly the
  // token would be silently dropped and the wheel would never appear.
  'https://www.bwanabet.com',
  'https://www.bwanabet.co.zm',
  // TEMPORARY (2026-07-21): BwanaBet dev environment for pre-launch widget
  // testing. Remove once the team confirms testing is done.
  'https://dev-bwanabet.energaming.services',
]);
```

- [ ] **Step 6: Verify manually**

Run the local dev server:

```bash
npm run dev
```

Open `http://localhost:3000/test.html` in a browser, run `window.BWANABET_WHEEL_DEBUG = true` in the console, reload, and confirm `[wheel]` lines appear tracing the gates. Expected: at minimum a line about the `token` cookie, since the local harness has no BwanaBet session.

- [ ] **Step 7: Commit**

```bash
git add public/embed.js components/WheelWidget.jsx
git commit -m "feat(embed): opt-in diagnostics for wheel visibility gates"
```

---

## Task 2: Availability decision helper (W2)

Pure logic, so it is unit-testable away from the DOM.

**Files:**
- Create: `lib/availability.mjs`
- Test: `lib/availability.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `lib/availability.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAvailability } from './availability.mjs';

// Only a genuine "you already spun today" may be written to the per-account
// localStorage cache. Every other unavailable verdict is transient and MUST NOT
// suppress the wheel for the rest of the wheel-day.

test('a spin is available -> shown, not sticky', () => {
  const v = decideAvailability({ status: 200, body: { available: true, reason: 'available' } });
  assert.deepEqual(v, { available: true, sticky: false, reason: 'available' });
});

test('already spun -> hidden AND sticky', () => {
  const v = decideAvailability({ status: 200, body: { available: false, reason: 'already_spun' } });
  assert.deepEqual(v, { available: false, sticky: true, reason: 'already_spun' });
});

test('maintenance -> hidden but NOT sticky', () => {
  const v = decideAvailability({ status: 200, body: { available: false, maintenance: true, reason: 'maintenance' } });
  assert.deepEqual(v, { available: false, sticky: false, reason: 'maintenance' });
});

test('expired token -> hidden but NOT sticky', () => {
  const v = decideAvailability({ status: 401, body: { available: false, error: 'token_expired', reason: 'token_expired' } });
  assert.deepEqual(v, { available: false, sticky: false, reason: 'token_expired' });
});

test('invalid token -> hidden but NOT sticky', () => {
  const v = decideAvailability({ status: 401, body: { available: false, error: 'invalid_token', reason: 'invalid_token' } });
  assert.deepEqual(v, { available: false, sticky: false, reason: 'invalid_token' });
});

test('unavailable with no reason (old deploy) -> hidden but NOT sticky', () => {
  const v = decideAvailability({ status: 200, body: { available: false } });
  assert.equal(v.available, false);
  assert.equal(v.sticky, false);
});

test('unreadable body -> fails OPEN, never sticky', () => {
  const v = decideAvailability({ status: 500, body: null });
  assert.deepEqual(v, { available: true, sticky: false, reason: 'unreadable' });
});

test('server fail-open response is available and not sticky', () => {
  const v = decideAvailability({ status: 200, body: { available: true, reason: 'check_failed' } });
  assert.equal(v.available, true);
  assert.equal(v.sticky, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/availability.test.mjs`
Expected: FAIL — `Cannot find module ... availability.mjs`

- [ ] **Step 3: Write minimal implementation**

Create `lib/availability.mjs`:

```javascript
// Decides what the widget does with a /api/spin-status response.
//
// `available` drives whether the host page shows the trigger button.
// `sticky`    says whether the verdict may be persisted to the per-account
//             localStorage cache.
//
// ONLY a genuine "you already spun today" is sticky. Maintenance mode, auth
// failures and server errors are transient: persisting them would suppress the
// wheel for the rest of the wheel-day and prevent later page loads from even
// retrying. Anything unreadable fails OPEN — /api/spin claims the daily spin
// atomically, so showing the wheel to someone who already spun is safe (they
// get `already_spun` back), whereas hiding it from someone who has not is not.

const STICKY_REASONS = new Set(['already_spun']);

export function decideAvailability({ status, body }) {
  if (!body || typeof body !== 'object') {
    return { available: true, sticky: false, reason: 'unreadable' };
  }
  if (body.available !== false) {
    return { available: true, sticky: false, reason: body.reason || 'available' };
  }
  const reason = body.reason || body.error || (status === 401 ? 'unauthenticated' : 'unknown');
  return { available: false, sticky: STICKY_REASONS.has(reason), reason };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/availability.test.mjs`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add lib/availability.mjs lib/availability.test.mjs
git commit -m "feat(wheel): availability verdict helper distinguishing sticky from transient"
```

---

## Task 3: spin-status returns a reason (W2)

**Files:**
- Modify: `app/api/spin-status/route.js`

- [ ] **Step 1: Add `reason` to every response path**

In `app/api/spin-status/route.js`, make these four edits.

Replace the maintenance branch (line 15):

```javascript
    return NextResponse.json({ available: false, maintenance: true });
```

with:

```javascript
    return NextResponse.json({ available: false, maintenance: true, reason: 'maintenance' });
```

Replace the auth-failure branch (line 30):

```javascript
    return NextResponse.json({ available: false, error: code }, { status: 401 });
```

with:

```javascript
    return NextResponse.json({ available: false, error: code, reason: code }, { status: 401 });
```

Replace the query-error fail-open branch (line 52):

```javascript
    return NextResponse.json({ available: true }); // fail open — claim_spin still dedupes
```

with:

```javascript
    // Fail open — claim_spin still dedupes. `check_failed` is deliberately NOT
    // a sticky reason: a DB hiccup must not suppress the wheel for the day.
    return NextResponse.json({ available: true, reason: 'check_failed' });
```

Replace the final verdict (line 55):

```javascript
  return NextResponse.json({ available: data.length === 0 });
```

with:

```javascript
  const available = data.length === 0;
  return NextResponse.json({ available, reason: available ? 'available' : 'already_spun' });
```

And the outer catch (line 64):

```javascript
    return NextResponse.json({ available: true });
```

with:

```javascript
    return NextResponse.json({ available: true, reason: 'check_failed' });
```

- [ ] **Step 2: Verify the route still compiles and answers**

```bash
npm run build
```

Expected: build succeeds with no errors in `app/api/spin-status/route.js`.

- [ ] **Step 3: Verify the unauthenticated path returns a reason**

With `npm run dev` running in another shell:

```bash
curl -s -X POST http://localhost:3000/api/spin-status -H 'Content-Type: application/json' -d '{}'
```

Expected output contains `"reason":"invalid_token"`.

- [ ] **Step 4: Commit**

```bash
git add app/api/spin-status/route.js
git commit -m "feat(spin-status): return a reason on every response path"
```

---

## Task 4: Widget uses the verdict and times out (W2)

**Files:**
- Modify: `components/WheelWidget.jsx`

- [ ] **Step 1: Import the helper and add the timeout constant**

In `components/WheelWidget.jsx`, add to the imports at the top (after the `spunCache` import on line 6):

```javascript
import { decideAvailability } from '@/lib/availability.mjs';
```

Then, immediately after the `const STORAGE_KEY = 'bwanabet_wheel_spin';` line (line 50), add:

```javascript
// Availability check timeout. Without this a HANG (as opposed to an error)
// means the widget never posts a verdict and the trigger button never appears
// until a full page reload — the `checked` latch prevents any retry.
const STATUS_TIMEOUT_MS = 4000;
```

- [ ] **Step 2: Rewrite `resolveAvailability`**

Replace the whole `resolveAvailability` function (currently lines 319–347) with:

```javascript
    const resolveAvailability = async (token) => {
      if (checked) return;
      checked = true;

      const customerId = customerIdFromToken(token);
      let available = !hasSpunToday(customerId);
      let sticky = available ? false : true; // local cache hit IS a real already-spun

      if (available) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
        try {
          const fp = await fpPromise;
          const res = await fetch('/api/spin-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, fingerprint: fp }),
            signal: controller.signal,
          });
          const body = await res.json().catch(() => null);
          const verdict = decideAvailability({ status: res.status, body });
          available = verdict.available;
          sticky = verdict.sticky;
        } catch {
          // Timeout or network error — fail open. /api/spin still enforces the
          // daily claim atomically, so this cannot produce a double spin.
          available = true;
          sticky = false;
        } finally {
          clearTimeout(timer);
        }
      }

      if (available) {
        setScreen('prompt');
      } else {
        // Only persist a verdict that genuinely means "you already spun today".
        // Maintenance mode and auth failures are transient and must not suppress
        // the wheel for the rest of the wheel-day.
        if (sticky) markSpun(customerId);
        setScreen('done');
      }
      window.parent.postMessage({ type: 'bwanabet-wheel-available', available, sticky }, '*');
    };
```

- [ ] **Step 3: Verify the build**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 4: Verify the full suite is still green**

```bash
npm test
```

Expected: `pass 79` (71 baseline + 8 from Task 2), `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add components/WheelWidget.jsx
git commit -m "fix(wheel): time out the availability check and only persist real already-spun verdicts"
```

---

## Task 5: embed.js honours sticky and reports a dead iframe (W2)

**Files:**
- Modify: `public/embed.js`

- [ ] **Step 1: Gate `markSpun` on the sticky flag**

In `public/embed.js`, replace the availability branch inside the message handler (as left by Task 1):

```javascript
      if (e.data.type === 'bwanabet-wheel-available') {
        dbg('availability verdict:', JSON.stringify(e.data));
        if (e.data.available) {
          btn.style.display = 'flex';
        } else {
          markSpun(activeCustomerId); // remember server verdict so future page loads skip the iframe
          hideButton();
        }
      }
```

with:

```javascript
      if (e.data.type === 'bwanabet-wheel-available') {
        dbg('availability verdict:', JSON.stringify(e.data));
        if (e.data.available) {
          btn.style.display = 'flex';
        } else {
          // Persist ONLY a genuine already-spun verdict. Maintenance mode and
          // expired tokens used to be cached here, which suppressed the wheel
          // for the whole wheel-day and stopped later page loads retrying.
          if (e.data.sticky) markSpun(activeCustomerId);
          else dbg('unavailable but NOT sticky - not caching; the next page load will retry');
          hideButton();
        }
      }
```

- [ ] **Step 2: Add the ready-timeout constant and flag**

Immediately after the `var STORAGE_KEY = 'bwanabet_wheel_spun';` line (line 7), add:

```javascript
  // If the widget iframe never signals ready within this window it was almost
  // certainly blocked (ad-blocker, DNS filter) or failed to load. We report it
  // so the failure is measurable instead of silent. The button deliberately
  // stays hidden — a button that opens a blank overlay is worse than none.
  var READY_TIMEOUT_MS = 8000;
```

- [ ] **Step 3: Track readiness and report failure**

Inside `initWidget`, declare the flag just after `initialized = true;` (line 85):

```javascript
    var readySeen = false;
```

Set it in the ready branch. Replace:

```javascript
      if (e.data.type === 'bwanabet-wheel-ready') {
        dbg('widget signalled ready - sending auth');
        sendAuth();
      }
```

with:

```javascript
      if (e.data.type === 'bwanabet-wheel-ready') {
        readySeen = true;
        dbg('widget signalled ready - sending auth');
        sendAuth();
      }
```

Then, at the very end of `initWidget` — after the `window.addEventListener('message', ...)` block closes and before the closing `}` of `initWidget` — add:

```javascript
    // Report a widget that never came alive. Sent as a text/plain beacon so it
    // is a CORS "simple request": no preflight, and no server changes needed
    // (/api/telemetry reads the raw body and JSON-parses it).
    setTimeout(function () {
      if (readySeen) return;
      dbg('widget never signalled ready within', READY_TIMEOUT_MS, 'ms - iframe blocked or failed to load');
      try {
        var payload = JSON.stringify({
          type: 'widget_never_ready',
          message: 'no bwanabet-wheel-ready within ' + READY_TIMEOUT_MS + 'ms',
          context: location.host,
        });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(WIDGET_URL + '/api/telemetry', new Blob([payload], { type: 'text/plain' }));
        } else {
          fetch(WIDGET_URL + '/api/telemetry', {
            method: 'POST',
            mode: 'no-cors',
            headers: { 'Content-Type': 'text/plain' },
            body: payload,
            keepalive: true,
          }).catch(function () {});
        }
      } catch (e) { /* never break the host page */ }
    }, READY_TIMEOUT_MS);
```

- [ ] **Step 4: Verify manually**

With `npm run dev` running, open `http://localhost:3000/test.html`, set `window.BWANABET_WHEEL_DEBUG = true`, reload, and confirm the `[wheel]` trace appears. To exercise the dead-iframe path, temporarily set `window.BWANABET_WIDGET_URL = 'https://blocked.invalid'` before the script loads and confirm the "never signalled ready" line appears after 8 seconds.

- [ ] **Step 5: Commit**

```bash
git add public/embed.js
git commit -m "fix(embed): only cache sticky verdicts; report a widget that never loads"
```

---

## Task 6: Cooldown window helper (W3)

Mirrors the SQL so the semantics are tested and documented in one place. Also used by the verification script in Task 10.

**Files:**
- Create: `lib/cooldown.js`
- Test: `lib/cooldown.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `lib/cooldown.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COOLDOWN_DAYS,
  resolveCooldownDays,
  shiftWheelDay,
  cooldownWindow,
  blocksSpin,
} from './cooldown.js';

// Rule: won on wheel-day D -> cannot win on D+1, D+2, D+3 -> winnable again D+4.

test('default cooldown is 3 days', () => {
  assert.equal(DEFAULT_COOLDOWN_DAYS, 3);
});

test('a win blocks the next three wheel-days', () => {
  const won = '2026-08-03';
  assert.equal(blocksSpin(won, '2026-08-04', 3), true);  // D+1
  assert.equal(blocksSpin(won, '2026-08-05', 3), true);  // D+2
  assert.equal(blocksSpin(won, '2026-08-06', 3), true);  // D+3
  assert.equal(blocksSpin(won, '2026-08-07', 3), false); // D+4 — winnable
});

test('a win does not block the day it happened (daily dedupe covers that)', () => {
  assert.equal(blocksSpin('2026-08-03', '2026-08-03', 3), false);
});

test('an older win does not block', () => {
  assert.equal(blocksSpin('2026-07-01', '2026-08-04', 3), false);
});

test('window spans a month boundary', () => {
  const won = '2026-07-31';
  assert.equal(blocksSpin(won, '2026-08-01', 3), true);
  assert.equal(blocksSpin(won, '2026-08-03', 3), true);
  assert.equal(blocksSpin(won, '2026-08-04', 3), false);
});

test('window spans a year boundary', () => {
  const won = '2025-12-31';
  assert.equal(blocksSpin(won, '2026-01-01', 3), true);
  assert.equal(blocksSpin(won, '2026-01-03', 3), true);
  assert.equal(blocksSpin(won, '2026-01-04', 3), false);
});

test('cooldown of 0 disables the rule entirely', () => {
  assert.equal(cooldownWindow('2026-08-04', 0), null);
  assert.equal(blocksSpin('2026-08-03', '2026-08-04', 0), false);
});

test('cooldownWindow returns the inclusive blocking range', () => {
  assert.deepEqual(cooldownWindow('2026-08-04', 3), { from: '2026-08-01', to: '2026-08-03' });
});

test('shiftWheelDay moves days in UTC across boundaries', () => {
  assert.equal(shiftWheelDay('2026-08-04', -1), '2026-08-03');
  assert.equal(shiftWheelDay('2026-08-01', -1), '2026-07-31');
  assert.equal(shiftWheelDay('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftWheelDay('2026-02-28', 1), '2026-03-01'); // 2026 is not a leap year
});

test('resolveCooldownDays falls back to the default on junk', () => {
  assert.equal(resolveCooldownDays(undefined), 3);
  assert.equal(resolveCooldownDays(null), 3);
  assert.equal(resolveCooldownDays(''), 3);
  assert.equal(resolveCooldownDays('abc'), 3);
  assert.equal(resolveCooldownDays('-1'), 3);
  assert.equal(resolveCooldownDays('2.5'), 3);
});

test('resolveCooldownDays honours valid values including the 0 kill-switch', () => {
  assert.equal(resolveCooldownDays('5'), 5);
  assert.equal(resolveCooldownDays('0'), 0);
  assert.equal(resolveCooldownDays(7), 7);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/cooldown.test.mjs`
Expected: FAIL — `Cannot find module ... cooldown.js`

- [ ] **Step 3: Write minimal implementation**

Create `lib/cooldown.js`:

```javascript
// Win-cooldown window arithmetic. Mirrors the SQL inside claim_spin so the
// semantics are tested in one place and reusable by the verification script.
//
// Rule: a customer who won on wheel-day D cannot win on D+1 .. D+n.
// Expressed at spin time on day P, a past win blocks the spin when it falls in
// [P - n, P - 1] inclusive — the SQL equivalent of
//   day_date >= p_day - p_cooldown_days AND day_date < p_day
//
// Days are wheel-day strings ('YYYY-MM-DD') as produced by getWheelDayDate().
// All arithmetic is UTC so it never depends on server local time. Wheel-day
// strings are zero-padded and fixed-width, so lexicographic comparison is
// equivalent to chronological comparison.

export const DEFAULT_COOLDOWN_DAYS = 3;

// Parse SPIN_COOLDOWN_DAYS. Absent, non-numeric, negative or fractional values
// fall back to the default. 0 is valid and disables the rule (kill-switch).
export function resolveCooldownDays(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_COOLDOWN_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_COOLDOWN_DAYS;
  return n;
}

// Move a wheel-day string by `delta` days, in UTC.
export function shiftWheelDay(day, delta) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

// Inclusive [from, to] range of wheel-days whose wins block a spin on `day`.
// Returns null when the cooldown is disabled.
export function cooldownWindow(day, cooldownDays) {
  if (!(cooldownDays > 0)) return null;
  return { from: shiftWheelDay(day, -cooldownDays), to: shiftWheelDay(day, -1) };
}

// True when a win on `winDay` blocks a spin on `spinDay`.
export function blocksSpin(winDay, spinDay, cooldownDays) {
  const w = cooldownWindow(spinDay, cooldownDays);
  if (!w) return false;
  return winDay >= w.from && winDay <= w.to;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/cooldown.test.mjs`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add lib/cooldown.js lib/cooldown.test.mjs
git commit -m "feat(wheel): cooldown window helper mirroring the claim_spin SQL"
```

---

## Task 7: Schema migration — columns and index (W3)

**Files:**
- Create: `supabase/migrations/2026-08-04-win-cooldown-columns.sql`

> **Critical:** `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. This file must **not** be wrapped in `BEGIN`/`COMMIT`, and each statement must be applied separately. This is the shared production database — a non-concurrent index build would hold a write lock on `wheel_spin_log`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/2026-08-04-win-cooldown-columns.sql`:

```sql
-- Wheel of Fortune — win-cooldown schema
-- Date: 2026-08-04
-- Safe to run multiple times.
--
-- NOT transaction-wrapped, on purpose: CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block. Apply these statements ONE AT A TIME. This is the
-- shared CRM/wheel production database; a plain CREATE INDEX would hold a write
-- lock on wheel_spin_log for the duration of the build.
--
-- ADD COLUMN ... NOT NULL DEFAULT <constant> is metadata-only on PG 11+, so
-- these are instant even on the ~100k-row spin log.

-- Prizes intercepted by the win cooldown, queued for the next qualifying
-- spinner. FIFO: index 0 is the head. Empty virtually all of the time.
ALTER TABLE wheel_daily_state
  ADD COLUMN IF NOT EXISTS carryover_prizes jsonb NOT NULL DEFAULT '[]'::jsonb;

-- A cooldown-blocked win is written to the log as an ordinary loss, so without
-- this flag it is indistinguishable from one and the rule is unverifiable.
ALTER TABLE wheel_spin_log
  ADD COLUMN IF NOT EXISTS cooldown_blocked boolean NOT NULL DEFAULT false;

-- Confirms an intercepted prize actually reached another player.
ALTER TABLE wheel_spin_log
  ADD COLUMN IF NOT EXISTS carryover_awarded boolean NOT NULL DEFAULT false;

-- Backs the cooldown lookup. Partial on `won`, so it indexes only winners
-- (~180 rows per 12 days) rather than the whole spin log.
CREATE INDEX CONCURRENTLY IF NOT EXISTS wheel_spin_log_winner_idx
  ON wheel_spin_log (customer_id, day_date)
  WHERE won;
```

- [ ] **Step 2: Apply it, one statement at a time**

Apply each of the four statements separately via the Supabase MCP `execute_sql` tool against project `blrrcnrhixckfudiojwe`. Do not paste the file as one batch — the `CONCURRENTLY` statement will fail if it is batched with others.

- [ ] **Step 3: Verify the schema landed**

Run this query:

```sql
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name IN ('carryover_prizes', 'cooldown_blocked', 'carryover_awarded')
ORDER BY table_name, column_name;
```

Expected: 3 rows — `wheel_daily_state.carryover_prizes`, `wheel_spin_log.carryover_awarded`, `wheel_spin_log.cooldown_blocked`.

Then confirm the index is valid (a failed `CONCURRENTLY` build leaves an invalid index behind):

```sql
SELECT indexrelid::regclass AS index, indisvalid
FROM pg_index
WHERE indexrelid = 'wheel_spin_log_winner_idx'::regclass;
```

Expected: one row, `indisvalid = true`. If it is `false`, drop the index and re-run the `CREATE INDEX CONCURRENTLY` statement.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-08-04-win-cooldown-columns.sql
git commit -m "feat(db): win-cooldown columns and winner index"
```

---

## Task 8: claim_spin with cooldown and carry-over (W3)

**Files:**
- Create: `supabase/migrations/2026-08-04-win-cooldown-rpc.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/2026-08-04-win-cooldown-rpc.sql`:

```sql
-- Wheel of Fortune — win cooldown + carry-over
-- Date: 2026-08-04
-- Safe to run multiple times.
--
-- Adds p_cooldown_days. A customer who won on wheel-day D cannot win on
-- D+1..D+p_cooldown_days. The intercepted prize is queued on
-- wheel_daily_state.carryover_prizes and awarded to the next qualifying
-- spinner, so a blocked win becomes someone else's win instead of vanishing.
--
-- Deposit-gate behaviour is UNCHANGED: an ineligible customer's win is still
-- destroyed and is NOT queued. Gate order matters — see GATE 1 / GATE 2 below.
--
-- Wrapped in ONE transaction so the DROP + CREATE is atomic: other sessions
-- block on the function lock and then see the NEW function, never a window
-- where claim_spin is missing (which would be a wheel outage on this shared
-- prod DB). Apply as ONE statement batch, NOT split per-statement.
--
-- Requires 2026-08-04-win-cooldown-columns.sql to have been applied first.
BEGIN;

DROP FUNCTION IF EXISTS public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean);

CREATE OR REPLACE FUNCTION public.claim_spin(
  p_day date,
  p_bucket text,
  p_customer text,
  p_fingerprint text,
  p_ip text,
  p_algorithm_id integer,
  p_winning_positions jsonb,
  p_skip_dedupe boolean DEFAULT false,
  p_force_prize integer DEFAULT NULL,
  p_eligible boolean DEFAULT true,
  p_cooldown_days integer DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout TO '5000ms'
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_seqname text;
  v_spin_number bigint;
  v_map jsonb;
  v_carry jsonb;
  v_wins int;
  v_budget int;
  v_prize int;
  v_is_win boolean;
  v_segment int;
  v_forced_ineligible boolean := false;
  v_cooldown_blocked boolean := false;
  v_carryover_awarded boolean := false;
  v_in_cooldown boolean := false;
  v_popped text;
BEGIN
  v_seqname := format('wheel_seq_%s_%s', to_char(p_day, 'YYYYMMDD'), substr(md5(p_bucket), 1, 8));

  IF NOT EXISTS (
    SELECT 1 FROM wheel_daily_state WHERE day_date = p_day AND test_bucket = p_bucket
  ) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('wheelinit|' || p_day::text || '|' || p_bucket, 0));
    INSERT INTO wheel_daily_state (
      day_date, test_bucket, algorithm_id, winning_positions,
      total_spins, total_wins, total_budget_spent
    ) VALUES (
      p_day, p_bucket, p_algorithm_id, p_winning_positions, 0, 0, 0
    )
    ON CONFLICT (day_date, test_bucket) DO NOTHING;
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS public.%I', v_seqname);
  END IF;

  -- Dedup on the CUSTOMER only, so different accounts can share one device.
  IF NOT p_skip_dedupe THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_day::text || '|' || p_bucket || '|cust|' || p_customer, 0)
    );

    IF EXISTS (
      SELECT 1 FROM wheel_spin_log
      WHERE day_date = p_day
        AND test_bucket = p_bucket
        AND customer_id = p_customer
      LIMIT 1
    ) THEN
      RETURN jsonb_build_object('error', 'already_spun');
    END IF;
  END IF;

  EXECUTE format('SELECT nextval(%L)', 'public.' || v_seqname) INTO v_spin_number;

  SELECT winning_positions, carryover_prizes INTO v_map, v_carry
  FROM wheel_daily_state
  WHERE day_date = p_day AND test_bucket = p_bucket;

  IF v_map IS NULL THEN
    RETURN jsonb_build_object('error', 'no_state');
  END IF;

  IF p_force_prize IS NOT NULL THEN
    v_prize := p_force_prize;
    v_is_win := true;
  ELSE
    v_prize := NULLIF(v_map ->> v_spin_number::text, '')::int;
    v_is_win := v_prize IS NOT NULL;
  END IF;

  -- GATE 1 — deposit eligibility. UNCHANGED: an ineligible customer's win is
  -- destroyed outright and is deliberately NOT queued for carry-over. This gate
  -- runs FIRST so that a spinner who is both ineligible AND in cooldown has
  -- their prize burned, exactly as today — reversing the order would quietly
  -- increase payout.
  IF v_is_win AND NOT p_eligible THEN
    v_is_win := false;
    v_prize := NULL;
    v_forced_ineligible := true;
  END IF;

  -- GATE 2 — win cooldown. Only reached by an otherwise fully-qualified winner,
  -- and only evaluated when this spin already landed on a winning position
  -- (~1% of spins), so the normal path pays nothing for this.
  IF v_is_win AND p_cooldown_days > 0 AND NOT p_skip_dedupe THEN
    SELECT EXISTS (
      SELECT 1 FROM wheel_spin_log
      WHERE customer_id = p_customer
        AND test_bucket = p_bucket
        AND won
        AND day_date >= p_day - p_cooldown_days
        AND day_date < p_day
    ) INTO v_in_cooldown;

    IF v_in_cooldown THEN
      -- Bank the prize for the next qualifying spinner instead of burning it.
      UPDATE wheel_daily_state
      SET carryover_prizes = carryover_prizes || to_jsonb(v_prize)
      WHERE day_date = p_day AND test_bucket = p_bucket;
      v_is_win := false;
      v_prize := NULL;
      v_cooldown_blocked := true;
    END IF;
  END IF;

  -- CARRY-OVER AWARD — a losing spin by a fully-qualified player collects a
  -- prize the cooldown intercepted earlier today. v_carry was read above and is
  -- empty virtually always, so the cooldown lookup below almost never runs.
  -- NOT v_cooldown_blocked keeps a just-blocked spinner from collecting the
  -- prize they themselves just banked.
  IF NOT v_is_win
     AND p_eligible
     AND NOT p_skip_dedupe
     AND NOT v_cooldown_blocked
     AND v_carry IS NOT NULL
     AND jsonb_array_length(v_carry) > 0
  THEN
    IF p_cooldown_days > 0 THEN
      SELECT EXISTS (
        SELECT 1 FROM wheel_spin_log
        WHERE customer_id = p_customer
          AND test_bucket = p_bucket
          AND won
          AND day_date >= p_day - p_cooldown_days
          AND day_date < p_day
      ) INTO v_in_cooldown;
    ELSE
      v_in_cooldown := false;
    END IF;

    IF NOT v_in_cooldown THEN
      -- Serialize poppers on this day's queue. Only reached when the queue is
      -- non-empty, so this lock is virtually never contended.
      PERFORM pg_advisory_xact_lock(
        hashtextextended('wheelcarry|' || p_day::text || '|' || p_bucket, 0)
      );

      SELECT carryover_prizes ->> 0 INTO v_popped
      FROM wheel_daily_state
      WHERE day_date = p_day
        AND test_bucket = p_bucket
        AND jsonb_array_length(carryover_prizes) > 0;

      IF v_popped IS NOT NULL THEN
        UPDATE wheel_daily_state
        SET carryover_prizes = carryover_prizes - 0
        WHERE day_date = p_day AND test_bucket = p_bucket;
        v_prize := v_popped::int;
        v_is_win := true;
        v_carryover_awarded := true;
      END IF;
    END IF;
  END IF;

  IF v_is_win THEN
    v_segment := CASE v_prize
      WHEN 10 THEN 0 WHEN 50 THEN 2 WHEN 200 THEN 4 WHEN 20 THEN 6 WHEN 100 THEN 8
      ELSE NULL END;
    IF v_segment IS NULL THEN
      RAISE EXCEPTION 'Unknown prize amount: %', v_prize;
    END IF;

    UPDATE wheel_daily_state
    SET total_wins = total_wins + 1,
        total_budget_spent = total_budget_spent + v_prize
    WHERE day_date = p_day AND test_bucket = p_bucket
    RETURNING total_wins, total_budget_spent INTO v_wins, v_budget;
  ELSE
    v_segment := (ARRAY[1, 3, 5, 7, 9])[1 + (floor(random() * 5))::int];
  END IF;

  INSERT INTO wheel_spin_log (
    day_date, test_bucket, customer_id, spin_number,
    won, prize_amount, segment_index, fingerprint, ip_address,
    cooldown_blocked, carryover_awarded
  ) VALUES (
    p_day, p_bucket, p_customer, v_spin_number,
    v_is_win, COALESCE(v_prize, 0), v_segment, p_fingerprint, p_ip,
    v_cooldown_blocked, v_carryover_awarded
  );

  RETURN jsonb_build_object(
    'win', v_is_win,
    'segment_index', v_segment,
    'prize_amount', v_prize,
    'spin_number', v_spin_number,
    'wins_today', v_wins,
    'budget_today', v_budget,
    'forced_loss_ineligible', v_forced_ineligible,
    'forced_loss_cooldown', v_cooldown_blocked,
    'carryover_awarded', v_carryover_awarded
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer) TO service_role;

COMMIT;
```

- [ ] **Step 2: Do NOT apply yet**

The verification script in Task 10 must exist before this goes near production. Commit the migration file now and apply it in Task 10, Step 3.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-08-04-win-cooldown-rpc.sql
git commit -m "feat(db): claim_spin enforces a win cooldown and carries blocked prizes over"
```

---

## Task 9: Wire the cooldown into the spin route (W3)

**Files:**
- Modify: `app/api/spin/route.js`
- Modify: `.env.example`

- [ ] **Step 1: Import the resolver and read the env var**

In `app/api/spin/route.js`, add to the imports (after the `checkDepositEligibility` import on line 13):

```javascript
import { resolveCooldownDays } from '@/lib/cooldown';
```

Then, immediately after the `SPIN_RATE_WINDOW_SEC` constant (line 32), add:

```javascript
// Win cooldown: a customer who won on wheel-day D cannot win on D+1..D+N.
// Env-tunable without a migration; 0 disables the rule (and carry-over with it).
const SPIN_COOLDOWN_DAYS = resolveCooldownDays(process.env.SPIN_COOLDOWN_DAYS);
```

- [ ] **Step 2: Pass it to the RPC**

In the `supabase.rpc('claim_spin', {...})` call (line 122), add the new parameter after `p_eligible`:

```javascript
    p_eligible: effectiveEligible,
    p_cooldown_days: SPIN_COOLDOWN_DAYS,
  });
```

- [ ] **Step 3: Document the env var**

In `.env.example`, add the following immediately after the `SPIN_MAINTENANCE=0` block:

```bash
# Win cooldown (spec 2026-08-04). A customer who wins on wheel-day D cannot win
# again until D+N+1. Default 3 (blocked D+1, D+2, D+3). Set to 0 to disable the
# rule and its prize carry-over entirely.
SPIN_COOLDOWN_DAYS=3
```

- [ ] **Step 4: Verify the build**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app/api/spin/route.js .env.example
git commit -m "feat(spin): pass the env-tunable win cooldown to claim_spin"
```

---

## Task 10: Verification script (W3)

Proves the SQL before it touches real traffic. Writes ~15 rows to a dedicated `test_bucket`. This is **not** a load test.

**Files:**
- Create: `scripts/cooldown-verify.mjs`

- [ ] **Step 1: Write the script**

Create `scripts/cooldown-verify.mjs`:

```javascript
// Verifies the win cooldown + carry-over behaviour of claim_spin against a
// dedicated test_bucket. Writes ~15 rows. NOT a load test — the production DB
// is shared with the CRM (see the 2026-07-13 incident).
//
// Usage:  node scripts/cooldown-verify.mjs
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { shiftWheelDay } from '../lib/cooldown.js';

for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const BUCKET = 'cooldown-test';
const DAY = '2030-01-10';           // far future: cannot collide with real traffic
const PREV = shiftWheelDay(DAY, -1); // inside the cooldown window
const OLD = shiftWheelDay(DAY, -4);  // outside the cooldown window

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}` + (ok ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`));
}

async function spin(customer, { eligible = true, forcePrize = null } = {}) {
  const { data, error } = await supabase.rpc('claim_spin', {
    p_day: DAY,
    p_bucket: BUCKET,
    p_customer: customer,
    p_fingerprint: null,
    p_ip: '127.0.0.1',
    p_algorithm_id: 2,
    p_winning_positions: {},   // no positional wins — forcePrize drives wins
    p_skip_dedupe: false,
    p_force_prize: forcePrize,
    p_eligible: eligible,
    p_cooldown_days: 3,
  });
  if (error) throw new Error(`claim_spin failed: ${error.message}`);
  return data;
}

async function queue() {
  const { data } = await supabase
    .from('wheel_daily_state')
    .select('carryover_prizes')
    .eq('day_date', DAY).eq('test_bucket', BUCKET).maybeSingle();
  return data ? data.carryover_prizes : null;
}

async function seedWin(customer, day, prize) {
  const { error } = await supabase.from('wheel_spin_log').insert({
    day_date: day, test_bucket: BUCKET, customer_id: customer,
    spin_number: 1, won: true, prize_amount: prize, segment_index: 0,
  });
  if (error) throw new Error(`seed failed: ${error.message}`);
}

async function cleanup() {
  await supabase.from('wheel_spin_log').delete().eq('test_bucket', BUCKET);
  await supabase.from('wheel_daily_state').delete().eq('test_bucket', BUCKET);
}

async function main() {
  await cleanup();

  // 1. A recent winner is blocked, and the prize is queued rather than burned.
  await seedWin('cd-recent', PREV, 50);
  const blocked = await spin('cd-recent', { forcePrize: 50 });
  check('recent winner does not win', blocked.win, false);
  check('block is attributed to the cooldown', blocked.forced_loss_cooldown, true);
  check('block is NOT attributed to the deposit gate', blocked.forced_loss_ineligible, false);
  check('prize is queued for carry-over', await queue(), [50]);

  // 2. An ineligible spinner must NOT collect the queued prize.
  const ineligible = await spin('cd-ineligible', { eligible: false });
  check('ineligible spinner does not collect', ineligible.carryover_awarded, false);
  check('queue is untouched by an ineligible spinner', await queue(), [50]);

  // 3. A spinner who is themselves in cooldown must NOT collect.
  await seedWin('cd-alsorecent', PREV, 10);
  const alsoRecent = await spin('cd-alsorecent');
  check('a spinner in cooldown does not collect', alsoRecent.carryover_awarded, false);
  check('queue is untouched by a cooling-down spinner', await queue(), [50]);

  // 4. The next fully-qualified spinner collects it.
  const collector = await spin('cd-collector');
  check('qualifying spinner collects the carry-over', collector.carryover_awarded, true);
  check('collector wins', collector.win, true);
  check('collector receives the exact banked prize', collector.prize_amount, 50);
  check('queue is drained', await queue(), []);

  // 5. A win older than the window does not block.
  await seedWin('cd-old', OLD, 20);
  const oldWinner = await spin('cd-old', { forcePrize: 20 });
  check('a win 4 days ago does not block', oldWinner.win, true);
  check('no cooldown attribution for an old win', oldWinner.forced_loss_cooldown, false);

  // 6. Concurrency: one banked prize, two qualifying spinners at once.
  await seedWin('cd-recent2', PREV, 100);
  await spin('cd-recent2', { forcePrize: 100 });
  check('second prize is queued', await queue(), [100]);
  const [a, b] = await Promise.all([spin('cd-race-a'), spin('cd-race-b')]);
  const awarded = [a, b].filter((r) => r.carryover_awarded).length;
  check('exactly one racer collects the single queued prize', awarded, 1);
  check('queue is drained after the race', await queue(), []);

  await cleanup();

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('verification threw:', err.message);
  await cleanup();
  process.exit(1);
});
```

- [ ] **Step 2: Run it before the migration to confirm it fails**

```bash
node scripts/cooldown-verify.mjs
```

Expected: exits 1 with `verification threw: claim_spin failed: ...` naming the missing
`p_cooldown_days` parameter (PostgREST cannot resolve the new signature yet). This
proves the script is actually exercising the new function rather than passing
against the old one.

- [ ] **Step 3: Apply the RPC migration**

Apply `supabase/migrations/2026-08-04-win-cooldown-rpc.sql` as **one statement batch** via the Supabase MCP `execute_sql` tool against project `blrrcnrhixckfudiojwe`. Do not split it — the `DROP` and `CREATE` must be atomic so no concurrent spin sees a missing function.

- [ ] **Step 4: Run the verification**

```bash
node scripts/cooldown-verify.mjs
```

Expected: every line reads `PASS`, final line `ALL CHECKS PASSED`, exit code 0.

If check 6 fails with 2 awards, the advisory lock is not serializing the pop — stop and re-examine the `pg_advisory_xact_lock` call in the carry-over block before proceeding.

- [ ] **Step 5: Confirm real traffic is unaffected**

```sql
SELECT count(*) AS spins_last_10_min,
       count(*) FILTER (WHERE won) AS wins,
       count(*) FILTER (WHERE cooldown_blocked) AS cooldown_blocked,
       count(*) FILTER (WHERE carryover_awarded) AS carryover_awarded
FROM wheel_spin_log
WHERE test_bucket = '' AND created_at > now() - interval '10 minutes';
```

Expected: `spins_last_10_min` is non-zero (real traffic still flowing) and no errors. `cooldown_blocked` will usually be 0 — the rule blocks roughly 0–1 wins per day.

- [ ] **Step 6: Commit**

```bash
git add scripts/cooldown-verify.mjs
git commit -m "test(wheel): verification script for cooldown and prize carry-over"
```

---

## Task 11: Report cooldown activity in the daily digest (W3)

Without this there is no routine signal that the rule is working.

**Files:**
- Modify: `app/api/digest/route.js`

- [ ] **Step 1: Query the two counters**

In `app/api/digest/route.js`, immediately after the `spinCount` query (which ends at line 41), add:

```javascript
    const { count: cooldownBlocked } = await supabase
      .from('wheel_spin_log')
      .select('id', { count: 'exact', head: true })
      .eq('day_date', day).eq('test_bucket', '').eq('cooldown_blocked', true);
    const { count: carryoverAwarded } = await supabase
      .from('wheel_spin_log')
      .select('id', { count: 'exact', head: true })
      .eq('day_date', day).eq('test_bucket', '').eq('carryover_awarded', true);
```

- [ ] **Step 2: Add the digest line**

Replace the `text = [...]` block (lines 51–56) with:

```javascript
      const blocked = cooldownBlocked ?? 0;
      const passedOn = carryoverAwarded ?? 0;
      const lines = [
        `📊 Wheel daily digest — ${day}`,
        spinsLine,
        `Wins: ${state?.total_wins ?? 0} → K${state?.total_budget_spent ?? 0} / K2,000 budget`,
      ];
      // Only mention the cooldown on days it actually fired — it blocks roughly
      // 0–1 wins/day, so a permanent "0 blocked" line would be noise.
      if (blocked > 0 || passedOn > 0) {
        lines.push(`Cooldown: ${blocked} blocked → ${passedOn} passed to other players`);
      }
      lines.push(`(errors delivered live; see alerts)`);
      text = lines.join('\n');
```

- [ ] **Step 3: Verify the build**

```bash
npm run build
```

Expected: build succeeds.

- [ ] **Step 4: Verify the digest renders**

With `npm run dev` running, and `CRON_SECRET` set in `.env.local`:

```bash
curl -s "http://localhost:3000/api/digest" -H "Authorization: Bearer $(grep '^CRON_SECRET=' .env.local | cut -d= -f2)"
```

Expected: `{"ok":true}`, and a digest message arrives in the alert Telegram chat. On a day with no cooldown activity the `Cooldown:` line is correctly absent.

- [ ] **Step 5: Run the full suite**

```bash
npm test
```

Expected: `pass 91` (71 baseline + 8 from Task 2 + 12 from Task 6), `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add app/api/digest/route.js
git commit -m "feat(digest): report cooldown blocks and prizes passed to other players"
```

---

## Post-implementation

**Deploy.** Push to `main`; Vercel deploys automatically. Set `SPIN_COOLDOWN_DAYS=3` in the Vercel project environment (the code defaults to 3 if unset, so this is documentation rather than a requirement).

**Diagnose the original report.** Ask the team member to open the BwanaBet site, run `window.BWANABET_WHEEL_DEBUG = true` in the console, reload, and send the `[wheel]` lines. The trace names the failing gate directly.

**Hand to the web team** (outside this repo): `www.bwanabet.co.zm` returns a bare 404 and needs a 301 to the apex domain.

**Watch for one week:**

```sql
-- Must return zero rows: nobody wins twice inside 4 wheel-days.
SELECT customer_id, array_agg(day_date ORDER BY day_date) AS win_days
FROM wheel_spin_log
WHERE test_bucket = '' AND won AND day_date >= current_date - 14
GROUP BY customer_id HAVING count(*) > 1;

-- Cooldown blocks should roughly equal prizes passed on (the queue drains).
SELECT day_date,
       count(*) FILTER (WHERE cooldown_blocked)  AS blocked,
       count(*) FILTER (WHERE carryover_awarded) AS passed_on
FROM wheel_spin_log
WHERE test_bucket = '' AND day_date >= current_date - 7
GROUP BY day_date ORDER BY day_date DESC;
```

A persistent gap between `blocked` and `passed_on` means prizes are being queued but never collected — check whether the queue is being left non-empty at day end.

**Deferred (spec §8).** The prize-credit reconciliation ledger. Build it only if a customer passes the deposit gate on D+4 or later with no genuine deposit — that is the signal that a payout was credited late enough to slip past the cooldown.
