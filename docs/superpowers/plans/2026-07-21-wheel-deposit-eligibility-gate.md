# Wheel Deposit-Eligibility Win Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only allow a wheel spin to win if the customer made a successful deposit during the previous wheel-day; otherwise force a loss — checked live at spin time by replaying the session token to BwanaBet's transaction-history API, fail-closed, with full sync+eventual tracking.

**Architecture:** Two pure library modules (UTC window math; deposit-record parsing) feed a thin orchestrator (`checkDepositEligibility`) that races a BwanaBet API fetch against a timeout and also exposes the eventual result. `/api/spin` runs the check before `claim_spin`, passes a new `p_eligible` flag into the RPC (which converts a would-be win into a loss when false), and logs both the sync verdict and the eventual ground-truth to a new `wheel_deposit_checks` table via `waitUntil`. Behavior is gated by `DEPOSIT_GATE_MODE` (`off`→`shadow`→`enforce`).

**Tech Stack:** Next.js 14 route handlers, `@supabase/supabase-js` (service role), `@vercel/functions` `waitUntil`, Node built-in test runner (`node --test`), Postgres/plpgsql.

**Spec:** `docs/superpowers/specs/2026-07-21-wheel-deposit-eligibility-gate-design.md`

---

## File structure

- **Create** `lib/wheelTime.js` — pure UTC window math (`previousWheelDayWindowUtc`).
- **Create** `lib/wheelTime.test.mjs` — boundary tests.
- **Create** `lib/depositEligibility.js` — pure record parsing (`hasQualifyingDeposit`).
- **Create** `lib/depositEligibility.test.mjs` — parsing tests.
- **Create** `lib/depositCheck.js` — orchestrator (`checkDepositEligibility`): fetch + race + completion.
- **Create** `lib/depositCheck.test.mjs` — mocked-fetch tests incl. the "late result still arrives" case.
- **Create** `supabase/migrations/2026-07-21-deposit-gate.sql` — `wheel_deposit_checks` table + `claim_spin` gains `p_eligible`.
- **Modify** `app/api/spin/route.js` — run the check, pass `p_eligible`, log via `waitUntil`.
- **Modify** `.env.example` (create if absent) — document the new env vars.

---

## Task 1: UTC previous-wheel-day window (`lib/wheelTime.js`)

**Files:**
- Create: `C:/Users/USER/Desktop/Claude projects/wheel-of-fortune/lib/wheelTime.js`
- Test: `C:/Users/USER/Desktop/Claude projects/wheel-of-fortune/lib/wheelTime.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `lib/wheelTime.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previousWheelDayWindowUtc } from './wheelTime.js';

// Wheel day flips at 06:00 CAT = 04:00 UTC. "Previous wheel-day" window is
// [curStart - 24h, curStart), all in UTC.

test('spin exactly at 06:00 CAT (04:00 UTC) -> window is the whole prior wheel-day', () => {
  const now = Date.parse('2026-07-21T04:00:00Z');
  const { prevStartMs, curStartMs } = previousWheelDayWindowUtc(now);
  assert.equal(new Date(curStartMs).toISOString(), '2026-07-21T04:00:00.000Z');
  assert.equal(new Date(prevStartMs).toISOString(), '2026-07-20T04:00:00.000Z');
});

test('spin mid-afternoon CAT stays on the same wheel-day', () => {
  const now = Date.parse('2026-07-21T12:00:00Z'); // 14:00 CAT
  const { prevStartMs, curStartMs } = previousWheelDayWindowUtc(now);
  assert.equal(new Date(curStartMs).toISOString(), '2026-07-21T04:00:00.000Z');
  assert.equal(new Date(prevStartMs).toISOString(), '2026-07-20T04:00:00.000Z');
});

test('before 06:00 CAT the wheel-day is still yesterday, so window rolls back one more day', () => {
  const now = Date.parse('2026-07-21T03:59:00Z'); // 05:59 CAT — before reset
  const { prevStartMs, curStartMs } = previousWheelDayWindowUtc(now);
  assert.equal(new Date(curStartMs).toISOString(), '2026-07-20T04:00:00.000Z');
  assert.equal(new Date(prevStartMs).toISOString(), '2026-07-19T04:00:00.000Z');
});

test('month boundary rolls back correctly', () => {
  const now = Date.parse('2026-08-01T05:00:00Z'); // 07:00 CAT on Aug 1 wheel-day
  const { prevStartMs, curStartMs } = previousWheelDayWindowUtc(now);
  assert.equal(new Date(curStartMs).toISOString(), '2026-08-01T04:00:00.000Z');
  assert.equal(new Date(prevStartMs).toISOString(), '2026-07-31T04:00:00.000Z');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './wheelTime.js'` (or `previousWheelDayWindowUtc is not a function`).

- [ ] **Step 3: Write the minimal implementation**

Create `lib/wheelTime.js`:

```javascript
// Pure UTC math for the "previous wheel-day" deposit window.
//
// The wheel day resets at 06:00 CAT. Zambia is CAT = UTC+2 (no DST), so the
// reset is 04:00 UTC. Everything here is computed in UTC on purpose — server
// local time must never be trusted (some hosts even mislabel Africa/Lusaka).

const CAT_OFFSET_MS = 2 * 60 * 60 * 1000; // UTC+2
const DAY_MS = 24 * 60 * 60 * 1000;

// Given a wall-clock instant (ms since epoch), return the UTC [start, end) of
// the PREVIOUS wheel-day: prevStartMs (inclusive) .. curStartMs (exclusive).
export function previousWheelDayWindowUtc(nowMs) {
  const cat = new Date(nowMs + CAT_OFFSET_MS);
  let y = cat.getUTCFullYear();
  let m = cat.getUTCMonth();
  let d = cat.getUTCDate();
  // Before 06:00 CAT we are still on the previous wheel-day.
  if (cat.getUTCHours() < 6) {
    const rolled = new Date(Date.UTC(y, m, d - 1));
    y = rolled.getUTCFullYear();
    m = rolled.getUTCMonth();
    d = rolled.getUTCDate();
  }
  const curStartMs = Date.UTC(y, m, d, 4, 0, 0, 0); // 04:00 UTC of the wheel-day
  const prevStartMs = curStartMs - DAY_MS;
  return { prevStartMs, curStartMs };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (all four `wheelTime` tests green).

- [ ] **Step 5: Commit**

```bash
git add lib/wheelTime.js lib/wheelTime.test.mjs
git commit -m "feat(wheel): UTC previous-wheel-day deposit window helper"
```

---

## Task 2: Deposit-record parsing (`lib/depositEligibility.js`)

**Files:**
- Create: `C:/Users/USER/Desktop/Claude projects/wheel-of-fortune/lib/depositEligibility.js`
- Test: `C:/Users/USER/Desktop/Claude projects/wheel-of-fortune/lib/depositEligibility.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `lib/depositEligibility.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasQualifyingDeposit } from './depositEligibility.js';

// Window: prior wheel-day = [2026-07-20T04:00Z, 2026-07-21T04:00Z)
const WIN = {
  prevStartMs: Date.parse('2026-07-20T04:00:00Z'),
  curStartMs: Date.parse('2026-07-21T04:00:00Z'),
};
const rec = (over) => ({ op_type: 'IN-KZ-AIRTEL', status: 'SUCCESS', created_at: '2026-07-20T10:00:00.000Z', ...over });

test('successful IN deposit inside the window qualifies', () => {
  assert.equal(hasQualifyingDeposit([rec()], WIN), true);
});

test('withdrawal (OUT) does not qualify', () => {
  assert.equal(hasQualifyingDeposit([rec({ op_type: 'OUT-KZ-AIRTEL' })], WIN), false);
});

test('non-SUCCESS deposit does not qualify', () => {
  assert.equal(hasQualifyingDeposit([rec({ status: 'PENDING' })], WIN), false);
});

test('deposit before the window start does not qualify', () => {
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-20T03:59:59.000Z' })], WIN), false);
});

test('deposit at curStart (exclusive upper bound) does not qualify', () => {
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-21T04:00:00.000Z' })], WIN), false);
});

test('deposit at prevStart (inclusive lower bound) qualifies', () => {
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-20T04:00:00.000Z' })], WIN), true);
});

test('empty / non-array / garbage input does not qualify', () => {
  assert.equal(hasQualifyingDeposit([], WIN), false);
  assert.equal(hasQualifyingDeposit(null, WIN), false);
  assert.equal(hasQualifyingDeposit([{}, { op_type: 'IN-X', status: 'SUCCESS', created_at: 'not-a-date' }], WIN), false);
});

test('mixed list qualifies if ANY record qualifies', () => {
  const data = [rec({ op_type: 'OUT-KZ-AIRTEL' }), rec({ created_at: '2026-07-20T23:00:00.000Z' })];
  assert.equal(hasQualifyingDeposit(data, WIN), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './depositEligibility.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/depositEligibility.js`:

```javascript
// Pure predicate: does this transaction-history payload contain a qualifying
// deposit for the given UTC window?
//
// A qualifying deposit is a record whose op_type marks a deposit (`IN-*`,
// e.g. "IN-KZ-AIRTEL"; withdrawals are `OUT-*`), whose status is SUCCESS, and
// whose created_at (UTC) falls in [prevStartMs, curStartMs).
export function hasQualifyingDeposit(data, { prevStartMs, curStartMs }) {
  if (!Array.isArray(data)) return false;
  return data.some((r) => {
    if (!r || typeof r.op_type !== 'string') return false;
    if (!r.op_type.startsWith('IN-')) return false;
    if (r.status !== 'SUCCESS') return false;
    const t = Date.parse(r.created_at);
    return Number.isFinite(t) && t >= prevStartMs && t < curStartMs;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS (all `depositEligibility` tests green).

- [ ] **Step 5: Commit**

```bash
git add lib/depositEligibility.js lib/depositEligibility.test.mjs
git commit -m "feat(wheel): qualifying-deposit predicate for eligibility gate"
```

---

## Task 3: Eligibility orchestrator (`lib/depositCheck.js`)

**Files:**
- Create: `C:/Users/USER/Desktop/Claude projects/wheel-of-fortune/lib/depositCheck.js`
- Test: `C:/Users/USER/Desktop/Claude projects/wheel-of-fortune/lib/depositCheck.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `lib/depositCheck.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDepositEligibility } from './depositCheck.js';

const NOW = Date.parse('2026-07-21T12:00:00Z'); // window: [2026-07-20T04:00Z, 2026-07-21T04:00Z)
const IN_WINDOW = '2026-07-20T10:00:00.000Z';

// A fake fetch returning a Response-like object with the given json + status.
const fakeFetch = (json, { status = 200, delayMs = 0 } = {}) => () =>
  new Promise((resolve) =>
    setTimeout(() => resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    }), delayMs));

const okBody = (records) => ({ error: false, message: 'Success', data: records });

test('timely qualifying deposit -> eligible / deposit_found', async () => {
  const { sync, completion } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 1000,
    fetchImpl: fakeFetch(okBody([{ op_type: 'IN-KZ-AIRTEL', status: 'SUCCESS', created_at: IN_WINDOW }])),
  });
  assert.equal(sync.eligible, true);
  assert.equal(sync.reason, 'deposit_found');
  const eventual = await completion;
  assert.equal(eventual.eligible, true);
  assert.equal(eventual.reason, 'deposit_found');
});

test('timely with only a withdrawal -> ineligible / no_deposit', async () => {
  const { sync } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 1000,
    fetchImpl: fakeFetch(okBody([{ op_type: 'OUT-KZ-AIRTEL', status: 'SUCCESS', created_at: IN_WINDOW }])),
  });
  assert.equal(sync.eligible, false);
  assert.equal(sync.reason, 'no_deposit');
});

test('non-200 -> fail-closed error', async () => {
  const { sync } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 1000, fetchImpl: fakeFetch(null, { status: 500 }),
  });
  assert.equal(sync.eligible, false);
  assert.equal(sync.reason, 'error');
});

test('api-level error:true -> fail-closed error', async () => {
  const { sync } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 1000, fetchImpl: fakeFetch({ error: true, message: 'nope', data: null }),
  });
  assert.equal(sync.eligible, false);
  assert.equal(sync.reason, 'error');
});

test('thrown network error -> fail-closed error', async () => {
  const { sync } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 1000,
    fetchImpl: () => Promise.reject(new Error('boom')),
  });
  assert.equal(sync.eligible, false);
  assert.equal(sync.reason, 'error');
});

test('slow call -> sync times out (fail-closed) but completion still resolves the real answer', async () => {
  const { sync, completion } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 20, bgCapMs: 1000,
    fetchImpl: fakeFetch(okBody([{ op_type: 'IN-KZ-AIRTEL', status: 'SUCCESS', created_at: IN_WINDOW }]), { delayMs: 100 }),
  });
  assert.equal(sync.eligible, false);
  assert.equal(sync.reason, 'timeout');
  const eventual = await completion;          // the late result must still arrive
  assert.equal(eventual.eligible, true);
  assert.equal(eventual.reason, 'deposit_found');
  assert.equal(Number.isFinite(eventual.latencyMs), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './depositCheck.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/depositCheck.js`. Note it is **`async`** — it awaits the race so the
returned `sync` is the resolved verdict (not a pending Promise), while
`completion` stays a Promise for the eventual result:

```javascript
import { previousWheelDayWindowUtc } from './wheelTime.js';
import { hasQualifyingDeposit } from './depositEligibility.js';

// Live deposit-eligibility check. Resolves to:
//   { sync, completion }
// - sync: the verdict that drives the spin, settled within timeoutMs
//     { eligible, reason, latencyMs }  reason ∈ deposit_found|no_deposit|timeout|error
//   Fail-closed: timeout / error ⇒ eligible=false.
// - completion: a Promise for the eventual ground-truth once the call finishes
//     { eligible, reason, latencyMs, httpStatus, error }
//   The fetch is NOT aborted on the sync timeout — it keeps running (hard-capped
//   by bgCapMs) so we can record whether a timed-out user was actually eligible.
export async function checkDepositEligibility({
  token,
  nowMs = Date.now(),
  timeoutMs = 2000,
  bgCapMs = 10000,
  apiBase = process.env.BWANA_API_BASE || 'https://api.bwanabet.co.zm',
  fetchImpl = fetch,
  clock = () => Date.now(),
}) {
  const win = previousWheelDayWindowUtc(nowMs);
  const t0 = clock();

  const completion = (async () => {
    const controller = new AbortController();
    const cap = setTimeout(() => controller.abort(), bgCapMs);
    if (typeof cap.unref === 'function') cap.unref();
    try {
      const res = await fetchImpl(`${apiBase}/api/v2/transactions/history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token },
        body: JSON.stringify({ days: '3' }),
        signal: controller.signal,
      });
      const latencyMs = clock() - t0;
      if (!res.ok) {
        return { eligible: false, reason: 'error', latencyMs, httpStatus: res.status, error: `http_${res.status}` };
      }
      const json = await res.json().catch(() => null);
      if (!json || json.error) {
        return { eligible: false, reason: 'error', latencyMs, httpStatus: res.status, error: 'api_error' };
      }
      const eligible = hasQualifyingDeposit(json.data, win);
      return {
        eligible,
        reason: eligible ? 'deposit_found' : 'no_deposit',
        latencyMs,
        httpStatus: res.status,
        error: null,
      };
    } catch (err) {
      return {
        eligible: false,
        reason: 'error',
        latencyMs: clock() - t0,
        httpStatus: null,
        error: String((err && err.message) || err).slice(0, 200),
      };
    } finally {
      clearTimeout(cap);
    }
  })();

  const timeout = new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ eligible: false, reason: 'timeout', latencyMs: clock() - t0 }),
      timeoutMs,
    );
    if (typeof timer.unref === 'function') timer.unref();
  });

  const sync = await Promise.race([completion, timeout]);
  return { sync, completion };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — including the "slow call" test proving the late result still resolves via `completion`.

- [ ] **Step 5: Commit**

```bash
git add lib/depositCheck.js lib/depositCheck.test.mjs
git commit -m "feat(wheel): deposit-eligibility orchestrator (race + background completion)"
```

---

## Task 4: Database — tracking table + `claim_spin` eligibility gate

**Files:**
- Create: `C:/Users/USER/Desktop/Claude projects/wheel-of-fortune/supabase/migrations/2026-07-21-deposit-gate.sql`

Apply against the CRM/wheel Supabase project (`blrrcnrhixckfudiojwe`) via the Supabase MCP `apply_migration`, or the SQL editor. `p_eligible` defaults to `true`, so the new function stays backward-compatible with the current route until Task 5 ships.

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/2026-07-21-deposit-gate.sql`:

```sql
-- Wheel of Fortune — Deposit-eligibility win gate
-- Date: 2026-07-21
-- Safe to run multiple times.

-- 1. Tracking table: one row per real spin that ran a deposit check.
CREATE TABLE IF NOT EXISTS wheel_deposit_checks (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  day_date            date        NOT NULL,
  customer_id         text        NOT NULL,
  mode                text        NOT NULL,   -- shadow | enforce
  decision            text        NOT NULL,   -- check's sync verdict: eligible | forced_loss
  enforced            boolean     NOT NULL,   -- true only when the verdict actually affected the spin
  reason              text        NOT NULL,   -- deposit_found | no_deposit | timeout | error
  sync_latency_ms     int,
  eventual_eligible   boolean,                -- null if the bg call never returned
  eventual_reason     text,                   -- deposit_found | no_deposit | error | bg_timeout
  eventual_latency_ms int,
  http_status         int,
  error_text          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wheel_deposit_checks_day_idx
  ON wheel_deposit_checks (day_date);

-- Lock down like the other wheel tables: RLS on, no policies (service_role
-- bypasses RLS); revoke direct access from anon/authenticated.
ALTER TABLE wheel_deposit_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wheel_deposit_checks FROM anon, authenticated;
GRANT ALL ON wheel_deposit_checks TO service_role;

-- 2. Replace claim_spin with a version that accepts p_eligible. Drop the older
-- overloads so there is exactly one function and no ambiguous resolution.
DROP FUNCTION IF EXISTS public.claim_spin(date, text, text, text, text, boolean, integer);
DROP FUNCTION IF EXISTS public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer);

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
  p_eligible boolean DEFAULT true
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
  v_wins int;
  v_budget int;
  v_prize int;
  v_is_win boolean;
  v_segment int;
  v_forced_ineligible boolean := false;
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

  IF NOT p_skip_dedupe THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_day::text || '|' || p_bucket || '|cust|' || p_customer, 0)
    );
    IF p_fingerprint IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(
        hashtextextended(p_day::text || '|' || p_bucket || '|fp|' || p_fingerprint, 0)
      );
    END IF;

    IF EXISTS (
      SELECT 1 FROM wheel_spin_log
      WHERE day_date = p_day
        AND test_bucket = p_bucket
        AND (customer_id = p_customer
             OR (p_fingerprint IS NOT NULL AND fingerprint = p_fingerprint))
      LIMIT 1
    ) THEN
      RETURN jsonb_build_object('error', 'already_spun');
    END IF;
  END IF;

  EXECUTE format('SELECT nextval(%L)', 'public.' || v_seqname) INTO v_spin_number;

  SELECT winning_positions INTO v_map
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

  -- Deposit gate: an ineligible customer cannot win — convert a would-be win
  -- into a loss BEFORE segment mapping and counter updates.
  IF v_is_win AND NOT p_eligible THEN
    v_is_win := false;
    v_prize := NULL;
    v_forced_ineligible := true;
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
    won, prize_amount, segment_index, fingerprint, ip_address
  ) VALUES (
    p_day, p_bucket, p_customer, v_spin_number,
    v_is_win, COALESCE(v_prize, 0), v_segment, p_fingerprint, p_ip
  );

  RETURN jsonb_build_object(
    'win', v_is_win,
    'segment_index', v_segment,
    'prize_amount', v_prize,
    'spin_number', v_spin_number,
    'wins_today', v_wins,
    'budget_today', v_budget,
    'forced_loss_ineligible', v_forced_ineligible
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean) TO service_role;
```

- [ ] **Step 2: Apply the migration**

Apply `supabase/migrations/2026-07-21-deposit-gate.sql` to project `blrrcnrhixckfudiojwe` (Supabase MCP `apply_migration`, name `deposit_gate_2026_07_21`, or paste into the SQL editor).
Expected: success, no errors.

- [ ] **Step 3: Smoke-test the gate on an isolated test bucket**

Run this SQL (Supabase MCP `execute_sql` on `blrrcnrhixckfudiojwe`). It uses a throwaway `test_bucket` and `p_skip_dedupe := true`, so it never touches real state:

```sql
-- Force a win but mark INELIGIBLE -> must come back as a loss, no win counted.
SELECT public.claim_spin(
  p_day => current_date,
  p_bucket => 'dep_gate_test',
  p_customer => 'tester-1',
  p_fingerprint => NULL,
  p_ip => '0.0.0.0',
  p_algorithm_id => 0,
  p_winning_positions => '{}'::jsonb,
  p_skip_dedupe => true,
  p_force_prize => 10,
  p_eligible => false
) AS ineligible_result;

-- Force a win and mark ELIGIBLE -> must come back as a win.
SELECT public.claim_spin(
  p_day => current_date,
  p_bucket => 'dep_gate_test',
  p_customer => 'tester-2',
  p_fingerprint => NULL,
  p_ip => '0.0.0.0',
  p_algorithm_id => 0,
  p_winning_positions => '{}'::jsonb,
  p_skip_dedupe => true,
  p_force_prize => 10,
  p_eligible => true
) AS eligible_result;
```

Expected:
- `ineligible_result` → `"win": false`, `"forced_loss_ineligible": true`, `segment_index` ∈ {1,3,5,7,9}.
- `eligible_result` → `"win": true`, `"forced_loss_ineligible": false`, `segment_index` = 0 (prize 10).

- [ ] **Step 4: Clean up the test bucket**

```sql
DELETE FROM wheel_spin_log   WHERE test_bucket = 'dep_gate_test';
DELETE FROM wheel_daily_state WHERE test_bucket = 'dep_gate_test';
-- Drop the throwaway per-day sequence created by the test bucket:
DO $$
DECLARE s text;
BEGIN
  s := format('wheel_seq_%s_%s', to_char(current_date,'YYYYMMDD'), substr(md5('dep_gate_test'),1,8));
  EXECUTE format('DROP SEQUENCE IF EXISTS public.%I', s);
END $$;
```

Expected: rows removed, sequence dropped.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-07-21-deposit-gate.sql
git commit -m "feat(db): wheel_deposit_checks table + claim_spin p_eligible gate"
```

---

## Task 5: Wire the check into `/api/spin`

**Files:**
- Modify: `C:/Users/USER/Desktop/Claude projects/wheel-of-fortune/app/api/spin/route.js`

- [ ] **Step 1: Add imports and config constants**

At the top of `app/api/spin/route.js`, after the existing imports (the last import is `import { reportError } from '@/lib/telemetry';`), add:

```javascript
import { checkDepositEligibility } from '@/lib/depositCheck';
```

And after the existing `export const dynamic = 'force-dynamic';` line, add:

```javascript
// Deposit-eligibility gate config. Mode: 'off' (no check) | 'shadow' (check +
// log, outcome unaffected) | 'enforce' (check gates the win). See spec
// 2026-07-21-wheel-deposit-eligibility-gate-design.md.
const DEPOSIT_GATE_MODE = process.env.DEPOSIT_GATE_MODE || 'off';
const DEPOSIT_CHECK_TIMEOUT_MS = Number(process.env.DEPOSIT_CHECK_TIMEOUT_MS) || 2000;
const DEPOSIT_CHECK_BG_CAP_MS = Number(process.env.DEPOSIT_CHECK_BG_CAP_MS) || 10000;
```

- [ ] **Step 2: Run the deposit check before `claim_spin`**

In `handleSpin`, locate the block that ends with `const supabase = getSupabase();` (immediately before the `supabase.rpc('claim_spin', …)` call). Insert the following BETWEEN `const supabase = getSupabase();` and the `claim_spin` call:

```javascript
  // --- Deposit-eligibility gate ---
  // Real traffic only; test/load traffic bypasses the external call entirely.
  // Effective eligibility feeds claim_spin; the full result is logged async.
  let effectiveEligible = true;      // default: do not block (off / shadow / test)
  let depositCompletion = null;      // Promise<eventual> to log via waitUntil
  let depositSync = null;            // sync verdict for logging
  const gateActive = !isTest && (DEPOSIT_GATE_MODE === 'shadow' || DEPOSIT_GATE_MODE === 'enforce');

  if (gateActive) {
    try {
      const check = await checkDepositEligibility({
        token,
        timeoutMs: DEPOSIT_CHECK_TIMEOUT_MS,
        bgCapMs: DEPOSIT_CHECK_BG_CAP_MS,
      });
      depositSync = check.sync;
      depositCompletion = check.completion;
      if (DEPOSIT_GATE_MODE === 'enforce') {
        effectiveEligible = check.sync.eligible;
      }
    } catch (err) {
      // Never let the gate break a spin. Fail-closed only in enforce mode.
      waitUntil(reportError(err, { route: 'spin', status: 200, code: 'deposit_check_threw' }));
      if (DEPOSIT_GATE_MODE === 'enforce') effectiveEligible = false;
      depositSync = { eligible: effectiveEligible, reason: 'error', latencyMs: null };
    }
  }
```

- [ ] **Step 3: Pass `p_eligible` into the `claim_spin` RPC**

In the same file, find the `supabase.rpc('claim_spin', { … })` argument object and add `p_eligible` as the final property. The updated call:

```javascript
  const { data: result, error: claimErr } = await supabase.rpc('claim_spin', {
    p_day: dayDate,
    p_bucket: bucket,
    p_customer: cleanId,
    p_fingerprint: fingerprint || null,
    p_ip: ip,
    p_algorithm_id: algorithmId,
    p_winning_positions: winningPositions,
    p_skip_dedupe: skipDedupe,
    p_force_prize: forceWin,
    p_eligible: effectiveEligible,
  });
```

- [ ] **Step 4: Log the check result via `waitUntil` (after a successful claim)**

Still in `handleSpin`, find the block that builds the final success response:

```javascript
  return NextResponse.json({
    win: result.win,
    segmentIndex: result.segment_index,
    prize: result.win ? { kwacha: result.prize_amount } : null,
  });
```

Immediately BEFORE that `return`, insert:

```javascript
  // Persist the deposit-check outcome (sync verdict + eventual ground truth)
  // off the hot path. Only for real gated traffic.
  if (gateActive && depositSync) {
    const decision = depositSync.eligible ? 'eligible' : 'forced_loss';
    waitUntil((async () => {
      let eventual = null;
      try {
        eventual = depositCompletion
          ? await Promise.race([
              depositCompletion,
              new Promise((r) => setTimeout(() => r({ reason: 'bg_timeout' }), DEPOSIT_CHECK_BG_CAP_MS + 1000)),
            ])
          : null;
      } catch { eventual = null; }
      try {
        await supabase.from('wheel_deposit_checks').insert({
          day_date: dayDate,
          customer_id: cleanId,
          mode: DEPOSIT_GATE_MODE,
          decision,
          enforced: DEPOSIT_GATE_MODE === 'enforce',
          reason: depositSync.reason,
          sync_latency_ms: depositSync.latencyMs ?? null,
          eventual_eligible: eventual && typeof eventual.eligible === 'boolean' ? eventual.eligible : null,
          eventual_reason: eventual ? eventual.reason : null,
          eventual_latency_ms: eventual && Number.isFinite(eventual.latencyMs) ? eventual.latencyMs : null,
          http_status: eventual ? (eventual.httpStatus ?? null) : null,
          error_text: eventual ? (eventual.error ?? null) : null,
        });
      } catch (err) {
        reportError(err, { route: 'spin', status: 200, code: 'deposit_log_failed' });
      }
    })());
  }
```

- [ ] **Step 5: Verify the build compiles**

Run: `npm run build`
Expected: build succeeds (route compiles; no type/syntax errors). If the environment cannot run a full Next build, at minimum run `node --check app/api/spin/route.js` — expected: no output (syntax OK).

- [ ] **Step 6: Confirm existing tests still pass**

Run: `npm test`
Expected: PASS — all `lib/*.test.mjs` including the new modules; nothing regressed.

- [ ] **Step 7: Commit**

```bash
git add app/api/spin/route.js
git commit -m "feat(spin): deposit-eligibility gate (shadow/enforce) with async tracking"
```

---

## Task 6: Document env vars and default-off safety

**Files:**
- Create/Modify: `C:/Users/USER/Desktop/Claude projects/wheel-of-fortune/.env.example`

- [ ] **Step 1: Document the new configuration**

Append to `.env.example` (create the file if it does not exist):

```bash
# --- Deposit-eligibility win gate (spec 2026-07-21) ---
# off = disabled (default); shadow = check + log only; enforce = gate the win.
DEPOSIT_GATE_MODE=off
# Sync timeout that drives the spin result (ms). Fail-closed past this.
DEPOSIT_CHECK_TIMEOUT_MS=2000
# Hard cap for the background call that records ground-truth eligibility (ms).
DEPOSIT_CHECK_BG_CAP_MS=10000
# BwanaBet API base (override only for staging).
BWANA_API_BASE=https://api.bwanabet.co.zm
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): document deposit-gate configuration (defaults to off)"
```

---

## Task 7: End-to-end verification in shadow mode

This task validates against the real BwanaBet API and confirms the one open assumption from the spec (the exact `IN-` deposit prefix). No code changes unless the prefix differs.

- [ ] **Step 1: Confirm the deposit op_type prefix against a real deposit**

Using a BwanaBet account that HAS a recent deposit, capture one transaction-history record (via the logged-in browser transaction-history view, or a server-side `curl` with a fresh token):

```bash
curl -s -X POST 'https://api.bwanabet.co.zm/api/v2/transactions/history' \
  -H 'Content-Type: application/json' -H "Authorization: <FRESH_TOKEN>" \
  --data '{"days":"30"}' | head -c 600
```

Expected: at least one record with `op_type` beginning `IN-` and `status:"SUCCESS"`.
If deposits use a different prefix, update `hasQualifyingDeposit` in `lib/depositEligibility.js` (Step-3 predicate) and its tests accordingly, then re-run `npm test` and re-commit.

- [ ] **Step 2: Deploy with `DEPOSIT_GATE_MODE=shadow`**

Set `DEPOSIT_GATE_MODE=shadow` (and the other vars from Task 6) in the Vercel project env, deploy, and perform one real spin as a logged-in user.
Expected: the spin behaves exactly as before (shadow never changes outcomes).

- [ ] **Step 2b: Verify a tracking row was written**

Run (Supabase MCP `execute_sql` on `blrrcnrhixckfudiojwe`):

```sql
SELECT day_date, customer_id, mode, decision, enforced, reason,
       sync_latency_ms, eventual_eligible, eventual_reason, eventual_latency_ms, http_status
FROM wheel_deposit_checks
ORDER BY created_at DESC
LIMIT 5;
```

Expected: a row with `mode='shadow'`, `enforced=false`, a `reason` of `deposit_found`/`no_deposit`, and populated `eventual_*` fields (proving the background completion logged the ground-truth).

- [ ] **Step 3: Watch the data, then decide**

Leave shadow mode running long enough to gather real spins. Evaluate:
- API success rate and p50/p95 `eventual_latency_ms`.
- False-denial rate = share of `decision='forced_loss'` rows where `eventual_eligible=true` (real depositors a timeout would have denied).

Only when those look acceptable, flip `DEPOSIT_GATE_MODE=enforce`. `off` remains the instant kill-switch. (No commit — operational step.)

---

## Notes for the executor

- **Do not run load tests against the shared DB** — it caused a prior CRM outage. Task 4's smoke test is a handful of `p_skip_dedupe` calls on a throwaway bucket, which is safe.
- **Never trust server-local time.** All window math goes through `lib/wheelTime.js` (UTC). This dev sandbox even mislabels `Africa/Lusaka` as UTC+0.
- **The token is a live credential.** Don't log raw tokens; `wheel_deposit_checks` stores no token.
- Deploy order is safe either way: the migration (Task 4) is backward-compatible (`p_eligible` defaults true) so it can ship before the route change (Task 5).
