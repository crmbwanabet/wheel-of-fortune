# Wheel Telemetry & Error Alerting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-built error/telemetry system that sends deduplicated instant error alerts (including unhandled/future errors) to the owner's Telegram DM, plus a daily activity digest, without ever writing to the shared Supabase DB or breaking a spin.

**Architecture:** A single `lib/telemetry.js` module owns formatting + Telegram delivery + in-memory dedup/throttle/rate-cap/health-signal. API routes wrap their handler in a catch-all that reports any unhandled error and also report explicit failure branches, all via `waitUntil` (fire-and-forget). A new `/api/telemetry` route ingests client/widget errors; a new `/api/digest` route (Vercel Cron, CRON_SECRET-gated) posts a daily summary from cheap DB reads.

**Tech Stack:** Next.js 14.2.35 App Router (Node runtime), `@vercel/functions` (`waitUntil`), Telegram Bot API, existing `@supabase/supabase-js`. `node --test` for unit tests.

**Reference spec:** `docs/superpowers/specs/2026-07-14-wheel-telemetry-error-alerting-design.md`

---

## File map

| Path | Responsibility | Change |
|------|----------------|--------|
| `lib/telemetry.js` | Core: reportError/sendTelegram/dedup/throttle/health-signal | **New** |
| `lib/telemetry.test.mjs` | Unit tests for the core | **New** |
| `app/api/spin/route.js` | Catch-all wrapper + reportError on 5xx branches | Modify |
| `app/api/spin-status/route.js` | Catch-all wrapper + reportError | Modify |
| `app/api/telemetry/route.js` | Client/widget error intake → reportError | **New** |
| `app/api/digest/route.js` | Cron daily digest (CRON_SECRET-gated) | **New** |
| `components/WheelWidget.jsx` | window error hook + spin-failure reporter → `/api/telemetry` | Modify |
| `vercel.json` | Add `crons` entry for `/api/digest` | Modify |

Env (set in Task 7): `TELEGRAM_ALERT_CHAT_ID`, `CRON_SECRET`. `TELEGRAM_BOT_TOKEN` already exists.

---

## Task 1: Core telemetry module (`lib/telemetry.js`)

**Files:**
- Create: `lib/telemetry.js`
- Test: `lib/telemetry.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `lib/telemetry.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportError, errorSignature, _resetTelemetry } from './telemetry.js';

// No TELEGRAM_ALERT_CHAT_ID / BOT_TOKEN in the test env, so sendTelegram is a
// no-op and reportError returns the alert text it WOULD have sent (or null).

test('errorSignature combines route and code/status', () => {
  assert.equal(errorSignature({ route: 'spin', status: 500 }), 'spin:500');
  assert.equal(errorSignature({ route: 'spin', code: 'db_error' }), 'spin:db_error');
  assert.equal(errorSignature({}), 'unknown:error');
});

test('first occurrence of a signature alerts immediately', async () => {
  _resetTelemetry();
  const t = await reportError(new Error('boom'), { route: 'spin', status: 500 }, 1000);
  assert.ok(t && t.includes('spin:500'));
  assert.ok(t.includes('boom'));
});

test('repeats within the window are counted silently, not re-sent', async () => {
  _resetTelemetry();
  await reportError(new Error('boom'), { route: 'spin', status: 500 }, 1000);
  const second = await reportError(new Error('boom'), { route: 'spin', status: 500 }, 2000);
  assert.equal(second, null); // suppressed (counting)
});

test('after the window elapses, a rollup with the count is sent', async () => {
  _resetTelemetry();
  await reportError(new Error('boom'), { route: 'spin', status: 500 }, 1000);
  await reportError(new Error('boom'), { route: 'spin', status: 500 }, 2000);
  await reportError(new Error('boom'), { route: 'spin', status: 500 }, 3000);
  // window = 5 min; jump past it
  const rollup = await reportError(new Error('boom'), { route: 'spin', status: 500 }, 1000 + 6 * 60 * 1000);
  assert.ok(rollup && /×|x/i.test(rollup)); // contains a count
  assert.ok(rollup.includes('spin:500'));
});

test('global rate cap suppresses beyond MAX_ALERTS_PER_MIN distinct signatures', async () => {
  _resetTelemetry();
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(await reportError(new Error('e' + i), { route: 'r' + i, status: 500 }, 1000 + i));
  }
  const sent = results.filter(Boolean).length;
  assert.ok(sent <= 6, `expected <=6 sent, got ${sent}`);
});

test('health signal fires when 5xx rate crosses threshold', async () => {
  _resetTelemetry();
  let health = null;
  for (let i = 0; i < 25; i++) {
    const t = await reportError(new Error('busy'), { route: 'spin', status: 503 }, 1000 + i * 100);
    if (t && t.includes('Elevated errors')) health = t;
  }
  assert.ok(health, 'expected a health-signal alert');
});

test('reportError never throws on a bad error object', async () => {
  _resetTelemetry();
  await assert.doesNotReject(() => reportError(null, { route: 'spin' }, 1000));
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `node --test lib/telemetry.test.mjs`
Expected: FAIL — `Cannot find module './telemetry.js'`.

- [ ] **Step 3: Implement `lib/telemetry.js`**

```js
// Self-built telemetry: format + deliver error alerts to the owner's Telegram DM,
// with in-memory dedup/throttle/rate-cap and a proactive health signal.
// NEVER writes to any database. Every path is wrapped so it cannot throw.

const ALERT_WINDOW_MS = 5 * 60 * 1000;   // repeats within this collapse into a rollup
const MAX_ALERTS_PER_MIN = 6;            // global cap on messages/minute
const HEALTH_THRESHOLD = 20;             // 5xx within 60s to trigger the health signal
const HEALTH_COOLDOWN_MS = 10 * 60 * 1000;

const _state = {
  sig: new Map(),        // signature -> { count, firstAt, lastAlertAt }
  minuteStart: 0,
  minuteSent: 0,
  recent5xx: [],
  lastHealthAlertAt: 0,
};

export function _resetTelemetry() {
  _state.sig.clear();
  _state.minuteStart = 0;
  _state.minuteSent = 0;
  _state.recent5xx = [];
  _state.lastHealthAlertAt = 0;
}

export function errorSignature(context = {}) {
  const route = context.route || 'unknown';
  const kind = context.code || context.status || context.type || 'error';
  return `${route}:${kind}`;
}

function truncate(s, n = 300) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chatId) {
    console.log('[telemetry:no-config]', text.split('\n')[0]);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error('[telemetry] send failed:', err && err.message);
  }
}

function underRateCap(now) {
  if (now - _state.minuteStart >= 60000) {
    _state.minuteStart = now;
    _state.minuteSent = 0;
  }
  if (_state.minuteSent >= MAX_ALERTS_PER_MIN) return false;
  _state.minuteSent += 1;
  return true;
}

function formatAlert(sig, message, context) {
  const lines = [`🔴 ${sig}`, truncate(message)];
  if (context.route) lines.push(`route: ${context.route}`);
  if (context.status) lines.push(`status: ${context.status}`);
  if (context.customerId) lines.push(`customer: ${context.customerId}`);
  if (context.source) lines.push(`source: ${context.source}`);
  return lines.join('\n');
}

// Returns the alert text that was dispatched, or null if suppressed/counted.
export async function reportError(err, context = {}, now = Date.now()) {
  try {
    const sig = errorSignature(context);
    const message = (err && err.message) || context.message || String(err || 'error');
    const status = Number(context.status) || 0;

    // --- Health signal: track 5xx rate ---
    if (status >= 500) {
      _state.recent5xx.push(now);
      _state.recent5xx = _state.recent5xx.filter((t) => now - t < 60000);
      if (
        _state.recent5xx.length >= HEALTH_THRESHOLD &&
        now - _state.lastHealthAlertAt > HEALTH_COOLDOWN_MS
      ) {
        _state.lastHealthAlertAt = now;
        if (underRateCap(now)) {
          const text = `⚠️ Elevated errors on ${context.route || 'the wheel'} — ${_state.recent5xx.length} 5xx in the last minute. Possible DB saturation.`;
          await sendTelegram(text);
          return text;
        }
      }
    }

    // --- Per-signature dedup/throttle ---
    const st = _state.sig.get(sig);
    if (!st) {
      _state.sig.set(sig, { count: 1, firstAt: now, lastAlertAt: now });
      if (underRateCap(now)) {
        const text = formatAlert(sig, message, context);
        await sendTelegram(text);
        return text;
      }
      return null;
    }

    st.count += 1;
    if (now - st.lastAlertAt >= ALERT_WINDOW_MS) {
      const total = st.count;
      st.count = 0;
      st.lastAlertAt = now;
      if (underRateCap(now)) {
        const mins = Math.round(ALERT_WINDOW_MS / 60000);
        const text = `🔴 ${sig} — ${total}× in the last ${mins} min\n${truncate(message)}`;
        await sendTelegram(text);
        return text;
      }
    }
    return null;
  } catch (e) {
    console.error('[telemetry] reportError failed:', e && e.message);
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test lib/telemetry.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/telemetry.js lib/telemetry.test.mjs
git commit -m "feat(telemetry): core error reporter with dedup, rate cap, health signal"
```

---

## Task 2: Wire telemetry into `/api/spin`

**Files:**
- Modify: `app/api/spin/route.js`

- [ ] **Step 1: Add the import**

Add to the imports at the top of `app/api/spin/route.js`:

```js
import { reportError } from '@/lib/telemetry';
```

- [ ] **Step 2: Rename the handler and add a catch-all wrapper**

Change the current `export async function POST(request) {` line to `async function handleSpin(request) {` (rename only; leave its body unchanged). Then add this new wrapper right after that function's closing brace:

```js
// Catch-all: any unhandled/unexpected error is reported (future-proofing) and
// returned as a generic 500. reportError is fire-and-forget via waitUntil.
export async function POST(request) {
  try {
    return await handleSpin(request);
  } catch (err) {
    waitUntil(reportError(err, { route: 'spin', status: 500, code: 'unhandled' }));
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Report the explicit failure branches**

In `handleSpin`, add a `waitUntil(reportError(...))` next to each existing 5xx `console.error`. Replace the `claimErr` block and the no-result block with:

```js
  if (claimErr) {
    if (claimErr.code === '57014') {
      waitUntil(reportError(claimErr, { route: 'spin', status: 503, code: 'server_busy' }));
      return NextResponse.json({ error: 'server_busy' }, { status: 503 });
    }
    waitUntil(reportError(claimErr, { route: 'spin', status: 500, code: 'claim_failed', customerId: cleanId }));
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
  if (!result) {
    waitUntil(reportError(new Error('claim_spin returned no result'), { route: 'spin', status: 500, code: 'no_result' }));
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
```

And replace the `result.error` (non-`already_spun`) block with:

```js
  if (result.error) {
    waitUntil(reportError(new Error(`RPC error: ${result.error}`), { route: 'spin', status: 500, code: result.error }));
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
```

- [ ] **Step 4: Verify the build**

Run: `npx next build`
Expected: `✓ Compiled successfully`, `/api/spin` listed.

- [ ] **Step 5: Commit**

```bash
git add app/api/spin/route.js
git commit -m "feat(spin): report 5xx and unhandled errors via telemetry"
```

---

## Task 3: Wire telemetry into `/api/spin-status`

**Files:**
- Modify: `app/api/spin-status/route.js`

- [ ] **Step 1: Add the import**

Add near the top of `app/api/spin-status/route.js`:

```js
import { reportError } from '@/lib/telemetry';
```

Also ensure `waitUntil` is imported (add `import { waitUntil } from '@vercel/functions';` if not already present).

- [ ] **Step 2: Rename handler + catch-all wrapper**

Rename the existing `export async function POST(request) {` to `async function handleStatus(request) {` (body unchanged), then append:

```js
export async function POST(request) {
  try {
    return await handleStatus(request);
  } catch (err) {
    waitUntil(reportError(err, { route: 'spin-status', status: 500, code: 'unhandled' }));
    // spin-status fails open — the atomic claim in /api/spin is the source of truth.
    return NextResponse.json({ available: true });
  }
}
```

- [ ] **Step 3: Report the query-failure branch**

Find the block that handles the Supabase query error (currently logs `[spin-status] query failed` and returns `{ available: true }`) and add before its return:

```js
    waitUntil(reportError(error, { route: 'spin-status', status: 500, code: 'query_failed' }));
```

- [ ] **Step 4: Verify the build**

Run: `npx next build`
Expected: `✓ Compiled successfully`.

- [ ] **Step 5: Commit**

```bash
git add app/api/spin-status/route.js
git commit -m "feat(spin-status): report query and unhandled errors via telemetry"
```

---

## Task 4: Client/widget error intake endpoint (`/api/telemetry`)

**Files:**
- Create: `app/api/telemetry/route.js`

- [ ] **Step 1: Create the route**

```js
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
```

- [ ] **Step 2: Verify the build**

Run: `npx next build`
Expected: `✓ Compiled successfully`, `/api/telemetry` listed.

- [ ] **Step 3: Commit**

```bash
git add app/api/telemetry/route.js
git commit -m "feat(telemetry): client/widget error intake endpoint"
```

---

## Task 5: Widget error reporter (`components/WheelWidget.jsx`)

**Files:**
- Modify: `components/WheelWidget.jsx`

- [ ] **Step 1: Add a module-scope reporter helper**

Add near the other module-scope helpers (e.g. after `postSpinWithRetry`):

```js
// Best-effort client error reporter → /api/telemetry. Deduped to one report
// per signature per page load; fully fire-and-forget (never throws/awaits).
const _reportedSigs = new Set();
function reportClientError(type, message, context) {
  try {
    const sig = `${type}:${String(message).slice(0, 80)}`;
    if (_reportedSigs.has(sig)) return;
    _reportedSigs.add(sig);
    fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, message: String(message).slice(0, 500), context }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* never break the widget */ }
}
```

- [ ] **Step 2: Install a window error handler on mount**

Inside the `WheelWidget` component, add a `useEffect` (place it near the existing mount effect):

```js
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onError = (e) => reportClientError('window_error', e?.message || 'error', e?.filename);
    const onRejection = (e) => reportClientError('unhandled_rejection', e?.reason?.message || String(e?.reason), null);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
```

- [ ] **Step 3: Report spin failures**

In the spin `postSpinWithRetry(...).then(res => res.json()).then(data => { ... })` chain, inside the `if (data.error)` branch (the non-`already_spun` error branch that lands on a loss), add:

```js
          reportClientError('spin_failed', data.error || 'unknown', null);
```

And in the `.catch(() => { ... })` network-error handler for the spin, add:

```js
        reportClientError('spin_network_error', 'spin request failed', null);
```

- [ ] **Step 4: Verify the build**

Run: `npx next build`
Expected: `✓ Compiled successfully`.

- [ ] **Step 5: Commit**

```bash
git add components/WheelWidget.jsx
git commit -m "feat(widget): report client + spin-failure errors to /api/telemetry"
```

---

## Task 6: Daily digest (`/api/digest`) + cron

**Files:**
- Create: `app/api/digest/route.js`
- Modify: `vercel.json`

- [ ] **Step 1: Create the digest route**

```js
import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { getWheelDayDate } from '@/lib/algorithms';

export const dynamic = 'force-dynamic';

// Posts a daily activity digest to the owner's Telegram DM. Cron-triggered.
// Reads ONLY aggregates (once/day) — never writes.
export async function POST(request) {
  return handleDigest(request);
}
export async function GET(request) {
  return handleDigest(request);
}

async function handleDigest(request) {
  // Auth: Vercel Cron sends the CRON_SECRET as a bearer token.
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization') || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  const day = getWheelDayDate();

  let text;
  try {
    const supabase = getSupabase();
    const { data: state } = await supabase
      .from('wheel_daily_state')
      .select('total_spins,total_wins,total_budget_spent')
      .eq('day_date', day).eq('test_bucket', '').maybeSingle();
    const { count: players } = await supabase
      .from('wheel_spin_log')
      .select('customer_id', { count: 'exact', head: true })
      .eq('day_date', day).eq('test_bucket', '');

    if (!state || state.total_spins === 0) {
      text = `📊 Wheel daily digest — ${day}\nQuiet day: 0 spins.`;
    } else {
      text = [
        `📊 Wheel daily digest — ${day}`,
        `Spins: ${state.total_spins} | Players: ${players ?? '—'}`,
        `Wins: ${state.total_wins} → K${state.total_budget_spent} / K2,000 budget`,
        `(errors delivered live; see alerts)`,
      ].join('\n');
    }
  } catch (err) {
    text = `📊 Wheel daily digest — ${day}\n⚠️ digest read failed: ${(err && err.message) || 'error'}`;
  }

  if (token && chatId) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch (err) {
      console.error('[digest] send failed:', err && err.message);
    }
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Add the cron to `vercel.json`**

Update `vercel.json` to (keeping the existing `functions`/`regions`):

```json
{
  "functions": {
    "app/api/spin/route.js": { "maxDuration": 15 }
  },
  "regions": ["dub1"],
  "crons": [
    { "path": "/api/digest", "schedule": "10 4 * * *" }
  ]
}
```

(`10 4 * * *` = 04:10 UTC = 06:10 CAT, just after the 06:00 CAT reset. Vercel Cron automatically sends the `CRON_SECRET` as the `Authorization: Bearer` header when the env var is set.)

- [ ] **Step 3: Verify the build**

Run: `npx next build`
Expected: `✓ Compiled successfully`, `/api/digest` listed.

- [ ] **Step 4: Commit**

```bash
git add app/api/digest/route.js vercel.json
git commit -m "feat(digest): daily activity digest via Vercel Cron (CRON_SECRET-gated)"
```

---

## Task 7: Configure env, deploy, and verify end-to-end

**Files:** none (config/deploy/verify).

- [ ] **Step 1: Capture the owner's Telegram DM chat id**

Ask the user to send the bot `@bwanabet_wheel_wins_bot` any direct message (e.g. "hi"). Then:

```bash
curl -s "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates" | grep -o '"chat":{"id":[0-9-]*,"first_name":"[^"]*"[^}]*"type":"private"' | head -1
```

Record the private chat `id` (a positive number for a personal DM).

- [ ] **Step 2: Set env vars in Vercel (all environments)**

```bash
printf '<CHAT_ID>' | npx vercel env add TELEGRAM_ALERT_CHAT_ID production
printf '<CHAT_ID>' | npx vercel env add TELEGRAM_ALERT_CHAT_ID preview
printf '<CHAT_ID>' | npx vercel env add TELEGRAM_ALERT_CHAT_ID development
# CRON_SECRET: generate a random value
SECRET=$(openssl rand -hex 24)
printf '%s' "$SECRET" | npx vercel env add CRON_SECRET production
```

Also add both to local `.env.local` for parity.

- [ ] **Step 3: Deploy**

```bash
npx vercel --prod --yes
```

- [ ] **Step 4: Verify an error alert arrives (isolated)**

Trigger a reportable error without harming the DB — send a malformed token so a handled path runs, then confirm the DM. Cleanest is a temporary forced error: hit `/api/telemetry` (client intake) directly, which reports to the DM:

```bash
curl -s -X POST "https://wheel-of-fortune-roan.vercel.app/api/telemetry" \
  -H "Content-Type: application/json" \
  -d '{"type":"verify","message":"telemetry pipeline test"}'
```

Expected: within a few seconds, a `🔴 widget:verify` DM arrives from the bot. Confirm with the user.

- [ ] **Step 5: Verify the digest**

```bash
curl -s -X POST "https://wheel-of-fortune-roan.vercel.app/api/digest" -H "Authorization: Bearer <CRON_SECRET>"
```

Expected: a `📊 Wheel daily digest` DM arrives. A call without the correct bearer returns 401.

- [ ] **Step 6: Confirm no DB writes from telemetry**

Via Supabase MCP, confirm no new rows were created by telemetry (row counts on `wheel_spin_log`/`wheel_daily_state` unchanged by the verification steps).

- [ ] **Step 7: Final commit / PR**

```bash
git commit --allow-empty -m "chore: telemetry system deployed and verified"
```

Open a PR from `feat/wheel-telemetry-alerting` into `main`.

---

## Self-review notes

- **Spec §4.1 (core module)** → Task 1. **§4.2 (server capture + catch-all)** → Tasks 2–3. **§4.3 (client intake + widget hook)** → Tasks 4–5. **§4.4 (health signal)** → Task 1 (in `reportError`) + verified in tests. **§4.5 (digest + cron)** → Task 6. **§3 (delivery/env) + §5 (config)** → Task 7. **§2 constraints** — no DB writes (telemetry reads only in digest; verified Task 7 Step 6); fire-and-forget via `waitUntil` (Tasks 2–5); flood-safe (Task 1 dedup/rate-cap, tested).
- **Naming consistency:** `reportError(err, context, now?)`, `errorSignature(context)`, `_resetTelemetry()` used identically across the module (Task 1) and all callers (Tasks 2–5). Context keys `{ route, status, code, customerId, source }` are consistent everywhere.
- **Known limitation (documented):** in-memory dedup is per serverless instance; the global rate cap bounds total volume. Precise cross-instance dedup / persistent error history is the deferred Vercel KV upgrade, not in this plan.
