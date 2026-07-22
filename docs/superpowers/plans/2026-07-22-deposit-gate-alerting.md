# Deposit-Gate Alerting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 10-minute Vercel cron (`/api/gate-monitor`) reads the durable `wheel_deposit_checks` table and DMs the owner when the deposit gate is unhealthy — API failing/degraded (mode-aware, stricter in enforce), latency-p95 spikes, and false-denials — with transition + cooldown anti-spam.

**Architecture:** Pure, unit-tested functions in `lib/gateHealth.js` (`evaluateGateHealth`, `decideAlerts`, `formatGateAlert`) do all the logic; the thin cron route queries the table, loads/saves per-condition state in a tiny new `wheel_monitor_state`, and sends via a shared `sendOwnerAlert` extracted from `lib/telemetry.js`. Reading the durable table sidesteps the in-memory telemetry fragmentation.

**Tech Stack:** Next.js 14 route handlers, `@supabase/supabase-js` (service role), Node built-in test runner, Postgres.

**Spec:** `docs/superpowers/specs/2026-07-22-deposit-gate-alerting-design.md`

---

## File structure

- **Create** `lib/gateHealth.js` — pure `evaluateGateHealth`, `decideAlerts`, `formatGateAlert`.
- **Create** `lib/gateHealth.test.mjs` — unit tests (no DB).
- **Modify** `lib/telemetry.js` — rename internal `sendTelegram` → exported `sendOwnerAlert`.
- **Create** `app/api/gate-monitor/route.js` — cron endpoint.
- **Create** `supabase/migrations/2026-07-22-gate-monitor-state.sql` — `wheel_monitor_state` table.
- **Modify** `vercel.json` — add the cron entry.
- **Modify** `.env.example` — document `GATE_MONITOR_*`.

---

## Task 1: Metrics + condition evaluation (`evaluateGateHealth`)

**Files:**
- Create: `lib/gateHealth.js`
- Test: `lib/gateHealth.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `lib/gateHealth.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGateHealth } from './gateHealth.js';

const TH = { minSample: 10, failRateShadow: 0.30, failRateEnforce: 0.20, p95Ms: 1500, falseDenials: 3 };
// helper to build N rows with overrides applied to the first `k`
const rows = (specs) => specs.flatMap(({ n, ...over }) => Array.from({ length: n }, () => ({
  mode: 'shadow', decision: 'eligible', reason: 'deposit_found', eventual_eligible: true, eventual_latency_ms: 200, ...over,
})));

test('healthy window: nothing fires', () => {
  const ev = evaluateGateHealth(rows([{ n: 20 }]), TH);
  assert.equal(ev.n, 20);
  assert.equal(ev.conditions.api_failing.firing, false);
  assert.equal(ev.conditions.latency.firing, false);
  assert.equal(ev.conditions.false_denials.firing, false);
});

test('shadow API failing: >=30% error/timeout with enough sample fires (warning)', () => {
  const ev = evaluateGateHealth(rows([
    { n: 8, reason: 'error', decision: 'forced_loss', eventual_eligible: false },
    { n: 12, reason: 'deposit_found' },
  ]), TH);
  assert.equal(ev.n, 20);
  assert.equal(ev.failureRate, 0.4);
  assert.equal(ev.conditions.api_failing.firing, true);
  assert.equal(ev.conditions.api_failing.severity, 'warning');
});

test('below min sample never fires api_failing', () => {
  const ev = evaluateGateHealth(rows([{ n: 3, reason: 'error', decision: 'forced_loss', eventual_eligible: false }]), TH);
  assert.equal(ev.conditions.api_failing.firing, false); // n=3 < minSample
});

test('enforce API failing uses stricter threshold + critical severity', () => {
  const ev = evaluateGateHealth(rows([
    { n: 3, mode: 'enforce', reason: 'timeout', decision: 'forced_loss', eventual_eligible: false },
    { n: 12, mode: 'enforce', reason: 'deposit_found' },
  ]), TH);
  assert.equal(ev.hasEnforce, true);
  assert.equal(ev.enforceN, 15);
  assert.equal(ev.enforceFailureRate, 0.2);
  assert.equal(ev.conditions.api_failing.firing, true);   // 20% >= failRateEnforce(0.20)
  assert.equal(ev.conditions.api_failing.severity, 'critical');
});

test('latency p95 fires when high (nearest-rank)', () => {
  // 19 fast + 1 slow -> p95 (index ceil(0.95*20)-1 = 18) is still fast; need more slow ones
  const ev = evaluateGateHealth(rows([
    { n: 18, eventual_latency_ms: 300 },
    { n: 2, eventual_latency_ms: 1800 },
  ]), TH);
  // sorted asc, N=20, p95 index = ceil(19)-1 = 18 -> the 19th value = 1800
  assert.equal(ev.p95LatencyMs, 1800);
  assert.equal(ev.conditions.latency.firing, true);
});

test('latency ignores null eventual_latency_ms', () => {
  const ev = evaluateGateHealth(rows([
    { n: 15, eventual_latency_ms: 200 },
    { n: 5, eventual_latency_ms: null },
  ]), TH);
  assert.equal(ev.p95LatencyMs, 200);
  assert.equal(ev.conditions.latency.firing, false);
});

test('false_denials counts forced_loss + eventual_eligible=true only', () => {
  const ev = evaluateGateHealth(rows([
    { n: 4, decision: 'forced_loss', eventual_eligible: true },   // false denials
    { n: 2, decision: 'forced_loss', eventual_eligible: false },  // legit denials
    { n: 2, decision: 'forced_loss', eventual_eligible: null },   // unknown (not counted)
    { n: 12, decision: 'eligible', eventual_eligible: true },
  ]), TH);
  assert.equal(ev.falseDenials, 4);
  assert.equal(ev.conditions.false_denials.firing, true);
});

test('empty window is safe', () => {
  const ev = evaluateGateHealth([], TH);
  assert.equal(ev.n, 0);
  assert.equal(ev.failureRate, 0);
  assert.equal(ev.p95LatencyMs, null);
  assert.equal(ev.conditions.api_failing.firing, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './gateHealth.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/gateHealth.js`:

```javascript
// Pure evaluation of deposit-gate health from wheel_deposit_checks rows.
// No DB, no time, no I/O — fully unit-testable.

const isFailure = (r) => r.reason === 'error' || r.reason === 'timeout';

// Nearest-rank percentile (matches Postgres percentile_disc): index = ceil(p*N)-1.
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

const pct = (x) => `${Math.round(x * 100)}%`;

// rows: [{ mode, decision, reason, eventual_eligible, eventual_latency_ms }]
// thresholds: { minSample, failRateShadow, failRateEnforce, p95Ms, falseDenials }
export function evaluateGateHealth(rows, thresholds) {
  const n = rows.length;
  const failures = rows.filter(isFailure).length;
  const failureRate = n > 0 ? failures / n : 0;

  const latencies = rows
    .map((r) => r.eventual_latency_ms)
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  const p95LatencyMs = percentile(latencies, 0.95);

  const falseDenials = rows.filter(
    (r) => r.decision === 'forced_loss' && r.eventual_eligible === true,
  ).length;

  const enforceRows = rows.filter((r) => r.mode === 'enforce');
  const enforceN = enforceRows.length;
  const enforceFailures = enforceRows.filter(isFailure).length;
  const enforceFailureRate = enforceN > 0 ? enforceFailures / enforceN : 0;
  const hasEnforce = enforceN > 0;

  const apiFailingFiring = hasEnforce
    ? enforceN >= thresholds.minSample && enforceFailureRate >= thresholds.failRateEnforce
    : n >= thresholds.minSample && failureRate >= thresholds.failRateShadow;

  const conditions = {
    api_failing: {
      firing: apiFailingFiring,
      severity: hasEnforce ? 'critical' : 'warning',
      value: hasEnforce
        ? `enforceFailRate=${pct(enforceFailureRate)} n=${enforceN}`
        : `failRate=${pct(failureRate)} n=${n}`,
    },
    latency: {
      firing: n >= thresholds.minSample && p95LatencyMs !== null && p95LatencyMs >= thresholds.p95Ms,
      severity: 'warning',
      value: `p95=${p95LatencyMs == null ? 'n/a' : p95LatencyMs + 'ms'} n=${n}`,
    },
    false_denials: {
      firing: falseDenials >= thresholds.falseDenials,
      severity: 'warning',
      value: `falseDenials=${falseDenials}`,
    },
  };

  return { n, failureRate, p95LatencyMs, falseDenials, hasEnforce, enforceN, enforceFailureRate, conditions };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS. Before this task the suite has 43 tests (from the deposit-gate feature); after adding 8 here it should be 51, all passing.

- [ ] **Step 5: Commit**

```bash
git add lib/gateHealth.js lib/gateHealth.test.mjs
git commit -m "feat(monitor): pure deposit-gate health evaluation"
```

---

## Task 2: Alert decisions + formatting (`decideAlerts`, `formatGateAlert`)

**Files:**
- Modify: `lib/gateHealth.js`
- Test: `lib/gateHealth.test.mjs`

- [ ] **Step 1: Write the failing test** (append to `lib/gateHealth.test.mjs`)

```javascript
import { decideAlerts, formatGateAlert } from './gateHealth.js';

const COOLDOWN = 30 * 60 * 1000;
const conds = (over = {}) => ({
  api_failing: { firing: false, severity: 'warning', value: 'x', ...over.api_failing },
  latency: { firing: false, severity: 'warning', value: 'x', ...over.latency },
  false_denials: { firing: false, severity: 'warning', value: 'x', ...over.false_denials },
});

test('first breach fires', () => {
  const out = decideAlerts(conds({ api_failing: { firing: true, severity: 'warning', value: 'x' } }), {}, 1000, COOLDOWN);
  assert.equal(out.length, 1);
  assert.equal(out[0].condition, 'api_failing');
  assert.equal(out[0].action, 'fire');
});

test('still firing within cooldown is silent', () => {
  const prior = { api_failing: { firing: true, lastAlertAt: 1000 } };
  const out = decideAlerts(conds({ api_failing: { firing: true, severity: 'warning', value: 'x' } }), prior, 1000 + COOLDOWN - 1, COOLDOWN);
  assert.equal(out.length, 0);
});

test('still firing past cooldown re-fires', () => {
  const prior = { api_failing: { firing: true, lastAlertAt: 1000 } };
  const out = decideAlerts(conds({ api_failing: { firing: true, severity: 'warning', value: 'x' } }), prior, 1000 + COOLDOWN, COOLDOWN);
  assert.equal(out.length, 1);
  assert.equal(out[0].action, 'fire');
});

test('cleared breach recovers', () => {
  const prior = { latency: { firing: true, lastAlertAt: 1000 } };
  const out = decideAlerts(conds(), prior, 5000, COOLDOWN);
  assert.equal(out.length, 1);
  assert.equal(out[0].condition, 'latency');
  assert.equal(out[0].action, 'recover');
});

test('never-fired and clear is a no-op', () => {
  assert.equal(decideAlerts(conds(), {}, 5000, COOLDOWN).length, 0);
});

test('formatGateAlert: enforce critical recommends off', () => {
  const ev = { n: 40, failureRate: 0.6, p95LatencyMs: 300, falseDenials: 0, hasEnforce: true, enforceN: 40, enforceFailureRate: 0.61 };
  const text = formatGateAlert({ condition: 'api_failing', action: 'fire', severity: 'critical' }, ev);
  assert.match(text, /ENFORCE/);
  assert.match(text, /DEPOSIT_GATE_MODE=off/);
});

test('formatGateAlert: recover line', () => {
  const ev = { n: 61 };
  const text = formatGateAlert({ condition: 'api_failing', action: 'recover', severity: 'warning' }, ev);
  assert.match(text, /recovered/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `decideAlerts`/`formatGateAlert` are not exported.

- [ ] **Step 3: Write the minimal implementation** (append to `lib/gateHealth.js`)

```javascript
// Decide which conditions to alert on, given prior persisted state.
// priorState: { [condition]: { firing: boolean, lastAlertAt: number|null } }
// Returns [{ condition, action: 'fire'|'recover', severity }].
export function decideAlerts(conditions, priorState, now, cooldownMs) {
  const out = [];
  for (const [name, cond] of Object.entries(conditions)) {
    const prior = priorState[name] || { firing: false, lastAlertAt: null };
    if (cond.firing) {
      const cooled = prior.lastAlertAt == null || now - prior.lastAlertAt >= cooldownMs;
      if (!prior.firing || cooled) out.push({ condition: name, action: 'fire', severity: cond.severity });
    } else if (prior.firing) {
      out.push({ condition: name, action: 'recover', severity: cond.severity });
    }
  }
  return out;
}

const LABELS = { api_failing: 'API degraded', latency: 'latency high', false_denials: 'false denials' };
const pctf = (x) => `${Math.round(x * 100)}%`;

// Build the Telegram text for one decision, using the evaluation's numbers.
export function formatGateAlert(decision, ev) {
  const label = LABELS[decision.condition] || decision.condition;
  if (decision.action === 'recover') {
    return `✅ Deposit gate: ${label} — recovered (n=${ev.n})`;
  }
  if (decision.condition === 'api_failing') {
    if (decision.severity === 'critical') {
      return [
        '🚨🚨 Deposit gate: ENFORCE + API DOWN',
        `${pctf(ev.enforceFailureRate)} of enforced checks failing (n=${ev.enforceN}) — players are being forced to lose.`,
        'Recommend: set DEPOSIT_GATE_MODE=off until BwanaBet recovers.',
      ].join('\n');
    }
    return `⚠️ Deposit gate: API degraded\n${pctf(ev.failureRate)} of checks errored/timed out (n=${ev.n}) — mode: shadow`;
  }
  if (decision.condition === 'latency') {
    return `⚠️ Deposit gate: latency high\np95 eventual latency ${ev.p95LatencyMs}ms (n=${ev.n}) — nearing the 2s timeout.`;
  }
  if (decision.condition === 'false_denials') {
    return `⚠️ Deposit gate: false denials\n${ev.falseDenials} real depositors ruled forced_loss — fail-closed is denying earned wins.`;
  }
  return `Deposit gate: ${label}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (7 new tests → 58 total).

- [ ] **Step 5: Commit**

```bash
git add lib/gateHealth.js lib/gateHealth.test.mjs
git commit -m "feat(monitor): alert transition/cooldown decisions + message formatting"
```

---

## Task 3: Export `sendOwnerAlert` from `lib/telemetry.js`

**Files:**
- Modify: `lib/telemetry.js`

- [ ] **Step 1: Rename the internal sender and export it**

In `lib/telemetry.js`, change the internal `async function sendTelegram(text) {` declaration to an exported `sendOwnerAlert`:

```javascript
// Send a plain-text alert to the owner's Telegram DM. Own try/catch; never throws.
export async function sendOwnerAlert(text) {
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
```

- [ ] **Step 2: Update internal call sites**

In `lib/telemetry.js`, replace both remaining `await sendTelegram(text);` calls (inside `reportError` — the health-signal branch and the per-signature branches) with `await sendOwnerAlert(text);`. There should be no remaining references to `sendTelegram`.

- [ ] **Step 3: Verify nothing broke**

Run: `npm test`
Expected: PASS — the existing `lib/telemetry.test.mjs` suite (7 tests) still passes; total remains 58.
Also run: `grep -n "sendTelegram" lib/telemetry.js` — expected: no output (all renamed).

- [ ] **Step 4: Commit**

```bash
git add lib/telemetry.js
git commit -m "refactor(telemetry): export sendOwnerAlert (shared DM sender)"
```

---

## Task 4: `wheel_monitor_state` migration

**Files:**
- Create: `supabase/migrations/2026-07-22-gate-monitor-state.sql`

Additive only (new table + grants); no function changes. Apply to project `blrrcnrhixckfudiojwe` via the Supabase MCP `apply_migration`/`execute_sql`. **Applying to prod requires the owner's go-ahead — pause for confirmation before Step 2.**

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/2026-07-22-gate-monitor-state.sql`:

```sql
-- Wheel of Fortune — gate-monitor alert state
-- Date: 2026-07-22. Safe to run multiple times.

CREATE TABLE IF NOT EXISTS wheel_monitor_state (
  condition     text PRIMARY KEY,            -- api_failing | latency | false_denials
  firing        boolean     NOT NULL DEFAULT false,
  last_alert_at timestamptz,
  last_value    text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE wheel_monitor_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wheel_monitor_state FROM anon, authenticated;
GRANT ALL ON wheel_monitor_state TO service_role;
```

- [ ] **Step 2: Apply to prod (after owner confirmation)**

Apply the file to `blrrcnrhixckfudiojwe`.
Expected: success.

- [ ] **Step 3: Verify**

Run (Supabase MCP `execute_sql`):

```sql
SELECT count(*) AS cols FROM information_schema.columns
WHERE table_schema='public' AND table_name='wheel_monitor_state';
```

Expected: `cols = 5`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-07-22-gate-monitor-state.sql
git commit -m "feat(db): wheel_monitor_state table for gate-monitor alert cooldown"
```

---

## Task 5: The cron endpoint (`/api/gate-monitor`)

**Files:**
- Create: `app/api/gate-monitor/route.js`

- [ ] **Step 1: Write the endpoint**

Create `app/api/gate-monitor/route.js`:

```javascript
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSupabase } from '@/lib/supabase';
import { reportError, sendOwnerAlert } from '@/lib/telemetry';
import { evaluateGateHealth, decideAlerts, formatGateAlert } from '@/lib/gateHealth';

export const dynamic = 'force-dynamic';

const WINDOW_MIN = Number(process.env.GATE_MONITOR_WINDOW_MIN) || 15;
const COOLDOWN_MIN = Number(process.env.GATE_MONITOR_COOLDOWN_MIN) || 30;
const THRESHOLDS = {
  minSample: Number(process.env.GATE_MONITOR_MIN_SAMPLE) || 10,
  failRateShadow: Number(process.env.GATE_MONITOR_FAIL_RATE_SHADOW) || 0.30,
  failRateEnforce: Number(process.env.GATE_MONITOR_FAIL_RATE_ENFORCE) || 0.20,
  p95Ms: Number(process.env.GATE_MONITOR_P95_MS) || 1500,
  falseDenials: Number(process.env.GATE_MONITOR_FALSE_DENIALS) || 3,
};

export async function GET(request) { return handle(request); }
export async function POST(request) { return handle(request); }

async function handle(request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization') || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const supabase = getSupabase();
    const now = Date.now();
    const sinceIso = new Date(now - WINDOW_MIN * 60 * 1000).toISOString();

    const { data: rows, error: qErr } = await supabase
      .from('wheel_deposit_checks')
      .select('mode,decision,reason,eventual_eligible,eventual_latency_ms')
      .gte('created_at', sinceIso);
    if (qErr) throw qErr;

    const ev = evaluateGateHealth(rows || [], THRESHOLDS);

    const { data: stateRows } = await supabase
      .from('wheel_monitor_state')
      .select('condition,firing,last_alert_at');
    const priorState = {};
    for (const s of stateRows || []) {
      priorState[s.condition] = {
        firing: s.firing,
        lastAlertAt: s.last_alert_at ? Date.parse(s.last_alert_at) : null,
      };
    }

    const decisions = decideAlerts(ev.conditions, priorState, now, COOLDOWN_MIN * 60 * 1000);
    for (const d of decisions) {
      await sendOwnerAlert(formatGateAlert(d, ev));
    }

    // Persist current state for every condition (fired ones get a fresh timestamp).
    const fired = new Set(decisions.filter((d) => d.action === 'fire').map((d) => d.condition));
    const nowIso = new Date(now).toISOString();
    const upserts = Object.entries(ev.conditions).map(([name, cond]) => ({
      condition: name,
      firing: cond.firing,
      last_alert_at: fired.has(name)
        ? nowIso
        : (priorState[name]?.lastAlertAt ? new Date(priorState[name].lastAlertAt).toISOString() : null),
      last_value: cond.value,
      updated_at: nowIso,
    }));
    await supabase.from('wheel_monitor_state').upsert(upserts, { onConflict: 'condition' });

    return NextResponse.json({
      ok: true,
      n: ev.n,
      alerts: decisions.map((d) => ({ condition: d.condition, action: d.action })),
    });
  } catch (err) {
    // A broken monitor must itself be visible.
    waitUntil(reportError(err, { route: 'gate-monitor', status: 500, code: 'monitor_query_failed' }));
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `node --check app/api/gate-monitor/route.js` — expected: no output.
Run: `npm run build` — expected: compiles; `/api/gate-monitor` appears as a route. (If the build fails for unrelated env/network reasons, `node --check` passing is sufficient — report what you see.)

- [ ] **Step 3: Confirm tests still pass**

Run: `npm test` — expected: 58 pass, 0 fail (endpoint isn't unit-tested; logic lives in the tested pure functions).

- [ ] **Step 4: Commit**

```bash
git add app/api/gate-monitor/route.js
git commit -m "feat(monitor): /api/gate-monitor cron endpoint (query -> evaluate -> alert -> persist)"
```

---

## Task 6: Cron schedule + env docs

**Files:**
- Modify: `vercel.json`
- Modify: `.env.example`

- [ ] **Step 1: Add the cron entry**

In `vercel.json`, add a second entry to the `crons` array so it reads:

```json
  "crons": [
    { "path": "/api/digest", "schedule": "10 4 * * *" },
    { "path": "/api/gate-monitor", "schedule": "*/10 * * * *" }
  ]
```

- [ ] **Step 2: Document the env vars**

Append to `.env.example`:

```bash
# --- Deposit-gate alerting monitor (spec 2026-07-22) ---
# Reuses CRON_SECRET + TELEGRAM_ALERT_CHAT_ID. All thresholds are tunable.
GATE_MONITOR_WINDOW_MIN=15
GATE_MONITOR_MIN_SAMPLE=10
GATE_MONITOR_FAIL_RATE_SHADOW=0.30
GATE_MONITOR_FAIL_RATE_ENFORCE=0.20
GATE_MONITOR_P95_MS=1500
GATE_MONITOR_FALSE_DENIALS=3
GATE_MONITOR_COOLDOWN_MIN=30
```

- [ ] **Step 3: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('vercel.json OK')"`
Expected: `vercel.json OK`.

- [ ] **Step 4: Commit**

```bash
git add vercel.json .env.example
git commit -m "feat(monitor): schedule /api/gate-monitor cron + document thresholds"
```

---

## Task 7: End-to-end verification (manual, isolated)

- [ ] **Step 1: Seed a throwaway failing window**

After deploy (or locally), insert a handful of synthetic rows into `wheel_deposit_checks` in the current window to trip a condition, e.g. (Supabase MCP `execute_sql`):

```sql
INSERT INTO wheel_deposit_checks (day_date, customer_id, mode, decision, enforced, reason, sync_latency_ms, eventual_eligible, eventual_reason, eventual_latency_ms, http_status, error_text)
SELECT current_date, 'monitor-test', 'shadow', 'forced_loss', false, 'error', 120, false, 'error', 120, 500, 'seed'
FROM generate_series(1, 12);
```

- [ ] **Step 2: Trigger the monitor**

`curl -s -X POST https://wheel-of-fortune-roan.vercel.app/api/gate-monitor -H "Authorization: Bearer <CRON_SECRET>"`
Expected: JSON `{"ok":true,"n":12,"alerts":[{"condition":"api_failing","action":"fire"}]}` and one DM (`⚠️ Deposit gate: API degraded … mode: shadow`).

- [ ] **Step 3: Confirm cooldown**

Immediately re-run the same curl.
Expected: `alerts: []` (still firing, within cooldown) — no second DM.

- [ ] **Step 4: Confirm recovery**

Delete the seed rows, then trigger again:

```sql
DELETE FROM wheel_deposit_checks WHERE customer_id = 'monitor-test';
```

`curl` again → expected: one recovery DM (`✅ … recovered`) and `wheel_monitor_state.firing=false` for `api_failing`.

- [ ] **Step 5: Clean up**

```sql
DELETE FROM wheel_deposit_checks WHERE customer_id = 'monitor-test';
UPDATE wheel_monitor_state SET firing=false, last_alert_at=NULL, last_value=NULL;
```

Confirm no other wheel table was written by the monitor (only `wheel_monitor_state`).

---

## Notes for the executor

- **Prod touches** are Task 4 Step 2 (apply migration) and Task 7 (seed/trigger against prod). Pause for owner confirmation before each, as with the deposit-gate feature.
- The monitor endpoint is separate from `/api/spin` and read-only except for `wheel_monitor_state` — it cannot affect a spin.
- Depends on the shipped `errCode 28 → no_deposit` fix (makes `reason='error'` a clean signal).
- Do not load-test the shared DB. The monitor's own query is a single windowed read every 10 min.
