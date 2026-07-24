# Shared-Device Account-Scoped Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let different BwanaBet accounts each get their daily spin on a shared store computer, by scoping every "already spun" guard to the customer account instead of the device, and relying on the deposit-eligibility gate (moved to enforce) as the anti-farming control.

**Architecture:** Three guards currently key on the *device*: (1) `embed.js` localStorage on `bwanabet.co.zm`, (2) `WheelWidget` localStorage on the widget origin, (3) the `fingerprint` half of the dedup in `spin-status` + `claim_spin`. We re-key the two localStorage caches by `customerId` and drop `fingerprint` from the server dedup (still logging it). Same-account protection is unaffected — `claim_spin` already dedupes on `customer_id`, and the fingerprint half only ever blocked *different* accounts on one device. Anti-farming shifts to the deposit gate (`DEPOSIT_GATE_MODE=enforce`), whose payout is additionally bounded by the daily budget/rigged map.

**Tech Stack:** Next.js (App Router) API routes, React client component (`WheelWidget.jsx`), a vanilla IIFE served from `public/embed.js`, Supabase Postgres (`claim_spin` SECURITY DEFINER plpgsql), Node `node:test` for unit tests.

---

## File Structure

- **Create** `lib/spunCache.mjs` — pure, unit-tested serialize/deserialize of the per-account "spun today" localStorage map. Imported by `WheelWidget.jsx`. Its schema is mirrored (inlined) in `public/embed.js`, which cannot import modules.
- **Create** `lib/spunCache.test.mjs` — `node:test` unit tests for the cache logic.
- **Modify** `components/WheelWidget.jsx` — decode `customerId` from the auth token; key `hasSpunToday`/`markSpun` by it.
- **Modify** `public/embed.js` — decode `customerId` from the session token; key the pop-up suppression and `markSpun` by it; fix the poll loop.
- **Modify** `app/api/spin-status/route.js` — dedupe on `customer_id` only.
- **Create** `supabase/migrations/2026-07-24-account-scoped-dedup.sql` — replace `claim_spin` to dedupe on `customer_id` only (drop the fingerprint advisory lock + fingerprint OR-clause); still log `fingerprint`.
- **Rollout (no file)** — flip `DEPOSIT_GATE_MODE=enforce` in Vercel and watch `/api/gate-monitor` + digest.

**Sequencing (safety):** apply the DB migration first (backward-compatible: old clients still over-restrict via `spin-status` fingerprint, so no double-spin), then deploy the code, then flip the gate to enforce. `DEPOSIT_GATE_MODE=off` remains the kill switch.

---

## Task 0: Branch

- [ ] **Step 1: Create a working branch**

Run:
```bash
git checkout -b feat/shared-device-account-scoped-dedup
```
Expected: `Switched to a new branch 'feat/shared-device-account-scoped-dedup'`

---

## Task 1: Pure per-account "spun today" cache

**Files:**
- Create: `lib/spunCache.mjs`
- Test: `lib/spunCache.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// lib/spunCache.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasSpun, withSpun } from './spunCache.mjs';

const DAY = '2026-07-24';
const PREV = '2026-07-23';

test('hasSpun: false when no stored value', () => {
  assert.equal(hasSpun(null, '207978', DAY), false);
  assert.equal(hasSpun('', '207978', DAY), false);
});

test('hasSpun: false without a customerId', () => {
  const raw = withSpun(null, '207978', DAY);
  assert.equal(hasSpun(raw, null, DAY), false);
  assert.equal(hasSpun(raw, '', DAY), false);
});

test('hasSpun: true only for the same account + same day', () => {
  const raw = withSpun(null, '207978', DAY);
  assert.equal(hasSpun(raw, '207978', DAY), true);   // same account, same day
  assert.equal(hasSpun(raw, '169', DAY), false);     // different account
  assert.equal(hasSpun(raw, '207978', PREV), false); // different day
});

test('withSpun: two accounts on one device are independent', () => {
  let raw = withSpun(null, '207978', DAY);
  raw = withSpun(raw, '169', DAY);
  assert.equal(hasSpun(raw, '207978', DAY), true);
  assert.equal(hasSpun(raw, '169', DAY), true);
});

test('withSpun: prunes entries from previous days', () => {
  const stale = JSON.stringify({ '111': PREV, '222': PREV });
  const raw = withSpun(stale, '207978', DAY);
  const map = JSON.parse(raw);
  assert.deepEqual(Object.keys(map).sort(), ['207978']); // stale pruned, today kept
  assert.equal(map['207978'], DAY);
});

test('withSpun: tolerates corrupt JSON', () => {
  const raw = withSpun('not-json{', '207978', DAY);
  assert.equal(hasSpun(raw, '207978', DAY), true);
});

test('hasSpun: tolerates corrupt JSON', () => {
  assert.equal(hasSpun('not-json{', '207978', DAY), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/spunCache.test.mjs`
Expected: FAIL — `Cannot find module './spunCache.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// lib/spunCache.mjs
// Per-account "already spun today" cache, persisted in localStorage as a map
// of { "<customerId>": "<wheelDay>" }. Scoping by customerId (not device) is
// what lets multiple accounts share one browser/computer — each account gets
// its own daily entry. Entries from previous wheel-days are pruned on write.

function parse(raw) {
  if (!raw) return {};
  try {
    const map = JSON.parse(raw);
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

export function hasSpun(raw, customerId, today) {
  if (!customerId) return false;
  return parse(raw)[customerId] === today;
}

export function withSpun(raw, customerId, today) {
  const map = parse(raw);
  const next = {};
  for (const [id, day] of Object.entries(map)) {
    if (day === today) next[id] = day; // keep only today's entries
  }
  if (customerId) next[customerId] = today;
  return JSON.stringify(next);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/spunCache.test.mjs`
Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/spunCache.mjs lib/spunCache.test.mjs
git commit -m "feat(wheel): per-account spun-today cache helper"
```

---

## Task 2: Account-scope the widget localStorage (`WheelWidget.jsx`)

**Files:**
- Modify: `components/WheelWidget.jsx:49-72` (helpers), token-decode + call sites (`:306`, `:325`, `:564`, `:581`)

- [ ] **Step 1: Replace the localStorage helpers with account-scoped versions**

Replace the block at `components/WheelWidget.jsx:49-72` (from `const STORAGE_KEY` through the end of `markSpun`) with:

```js
const STORAGE_KEY = 'bwanabet_wheel_spin';

function getWheelDayClient() {
  const now = new Date();
  const catMs = now.getTime() + (2 * 60 * 60 * 1000);
  const catDate = new Date(catMs);
  if (catDate.getUTCHours() < 6) {
    catDate.setUTCDate(catDate.getUTCDate() - 1);
  }
  return catDate.toISOString().split('T')[0];
}

// Browser-safe decode of the BwanaBet JWT payload id (no signature check —
// this only keys a client-side cache; the server re-verifies on every call).
function customerIdFromToken(raw) {
  try {
    const part = String(raw).split('.')[1];
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return payload && payload.id != null && payload.id !== '' ? String(payload.id) : null;
  } catch {
    return null;
  }
}

function hasSpunToday(customerId) {
  try {
    return hasSpun(localStorage.getItem(STORAGE_KEY), customerId, getWheelDayClient());
  } catch {
    return false;
  }
}

function markSpun(customerId) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      withSpun(localStorage.getItem(STORAGE_KEY), customerId, getWheelDayClient()),
    );
  } catch { /* ignore quota/availability errors */ }
}
```

- [ ] **Step 2: Add the import**

At the top of `components/WheelWidget.jsx`, immediately after the existing `import { generateFingerprint } from '@/lib/fingerprint';` line (`:5`), add:

```js
import { hasSpun, withSpun } from '@/lib/spunCache.mjs';
```

- [ ] **Step 3: Pass the customerId at the availability check**

In `resolveAvailability(token)` (around `:306`), replace:

```js
      let available = !hasSpunToday();
```
with:
```js
      const customerId = customerIdFromToken(token);
      let available = !hasSpunToday(customerId);
```

And in the same function replace the `markSpun();` at `:325` with:
```js
        markSpun(customerId); // sync localStorage so future page loads skip the check
```

- [ ] **Step 4: Pass the customerId at the spin-result call sites**

In the spin handler (around `:556`), immediately before `postSpinWithRetry(` add:
```js
    const spunCustomerId = customerIdFromToken(authTokenRef.current);
```
Then replace the two `markSpun();` calls in the `.then(...)` (the `already_spun` branch at `:564` and the success branch at `:581`) with:
```js
          markSpun(spunCustomerId);
```
(both occurrences — same replacement text).

- [ ] **Step 5: Verify the build compiles and existing tests pass**

Run: `npm run build`
Expected: build succeeds (no import/reference errors for `hasSpun`, `withSpun`, `customerIdFromToken`, `spunCustomerId`).

Run: `node --test lib/spunCache.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add components/WheelWidget.jsx
git commit -m "feat(wheel): account-scope widget spun-today cache"
```

---

## Task 3: Account-scope the host-page suppression (`public/embed.js`)

**Files:**
- Modify: `public/embed.js` — `STORAGE_KEY`/`hasSpunToday`/`markSpun` (`:7`, `:40-51`), the top-level guard (`:54`), the `markSpun()` call sites (`:208`, `:218`), and the poll loop (`:231-251`)

This file is a standalone IIFE loaded via `<script>` and cannot import modules, so the cache schema from `lib/spunCache.mjs` is mirrored inline. Keep the JSON shape identical (`{ "<id>": "<day>" }`) for consistency.

- [ ] **Step 1: Add an id decoder and replace the cache helpers**

Replace the `hasSpunToday`/`markSpun` block at `public/embed.js:40-51` with:

```js
  // Browser-safe decode of the session JWT payload id (keys the cache only).
  function customerIdFromToken(raw) {
    try {
      var payload = JSON.parse(atob(raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload && payload.id != null && payload.id !== '' ? String(payload.id) : null;
    } catch (e) { return null; }
  }

  // Per-account "spun today" map: { "<customerId>": "<wheelDay>" }. Scoping by
  // account (not device) lets multiple people share one computer.
  function readSpunMap() {
    try {
      var m = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return m && typeof m === 'object' ? m : {};
    } catch (e) { return {}; }
  }

  function hasSpunToday(customerId) {
    if (!customerId) return false;
    return readSpunMap()[customerId] === getWheelDay();
  }

  function markSpun(customerId) {
    if (!customerId) return;
    var today = getWheelDay();
    var map = readSpunMap();
    var next = {};
    for (var id in map) {
      if (Object.prototype.hasOwnProperty.call(map, id) && map[id] === today) next[id] = map[id];
    }
    next[customerId] = today;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
  }
```

(Leave `STORAGE_KEY` at `:7` as `'bwanabet_wheel_spun'` — the schema changed from `{day}` to a map, but the key name stays; a stale `{day}` value is treated as an empty map by `readSpunMap`, so it self-heals.)

- [ ] **Step 2: Make the top-level guard account-aware**

Replace the block at `public/embed.js:53-54`:
```js
  // Don't show if already spun today
  if (hasSpunToday()) return;
```
with:
```js
  // Don't show if THIS account already spun today. If we can't read a token
  // yet (SPA pre-login), fall through — the poll loop below waits for login.
  var earlyToken = readValidToken();
  if (earlyToken && hasSpunToday(customerIdFromToken(earlyToken))) return;
```

- [ ] **Step 3: Thread the customerId through `initWidget`**

Change the `initWidget` signature at `public/embed.js:59` from:
```js
  function initWidget(authToken) {
```
to:
```js
  function initWidget(authToken) {
    var customerId = customerIdFromToken(authToken);
```
(keep the existing `if (initialized) return; initialized = true;` lines directly after.)

Then update the two `markSpun()` call sites inside the message listener:
- At `:208` (the `available === false` branch) replace `markSpun();` with `markSpun(customerId);`
- At `:218` (the `bwanabet-wheel-spun` branch) replace `markSpun();` with `markSpun(customerId);`

- [ ] **Step 4: Fix the poll loop**

In the `else` polling branch (`:238-250`), the stop-condition currently calls the account-agnostic `hasSpunToday()`. Since we have no token there, replace the condition at `:241`:
```js
      if (hasSpunToday() || waited >= MAX_WAIT_MS) {
```
with:
```js
      if (waited >= MAX_WAIT_MS) {
```
(Once a token appears, `initWidget` runs and its own per-account check/`resolveAvailability` handshake governs display.)

- [ ] **Step 5: Manual verification (documented — no automated DOM harness)**

Verify by reading the diff that:
1. `customerIdFromToken` is defined before first use.
2. Every `hasSpunToday(...)` / `markSpun(...)` call passes a customerId.
3. `initWidget` defines `customerId` from `authToken`.

Run: `node -e "new Function(require('fs').readFileSync('public/embed.js','utf8')); console.log('parse OK')"`
Expected: `parse OK` (the file is syntactically valid JS).

- [ ] **Step 6: Commit**

```bash
git add public/embed.js
git commit -m "feat(wheel): account-scope host-page pop-up suppression"
```

---

## Task 4: Dedupe `spin-status` on customer only

**Files:**
- Modify: `app/api/spin-status/route.js:43-51`

- [ ] **Step 1: Replace the dedup query with a customer-only lookup**

Replace the block at `app/api/spin-status/route.js:43-51`:
```js
  let query = supabase
    .from('wheel_spin_log')
    .select('customer_id')
    .eq('day_date', dayDate)
    .eq('test_bucket', '')
    .limit(1);
  query = fingerprint
    ? query.or(`customer_id.eq.${customerId},fingerprint.eq.${fingerprint}`)
    : query.eq('customer_id', customerId);
```
with:
```js
  // Dedupe on the customer only — NOT the device fingerprint — so multiple
  // accounts can share one computer. Anti-farming is handled by the deposit
  // gate. `fingerprint` is still accepted (and logged at spin time) but no
  // longer gates availability.
  const query = supabase
    .from('wheel_spin_log')
    .select('customer_id')
    .eq('day_date', dayDate)
    .eq('test_bucket', '')
    .eq('customer_id', customerId)
    .limit(1);
```

- [ ] **Step 2: Remove the now-unused fingerprint parsing (optional tidy)**

The `fingerprint` const at `:35-38` is no longer used. Delete the block:
```js
  const fingerprint =
    typeof body.fingerprint === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.fingerprint)
      ? body.fingerprint
      : null;
```
and its preceding comment at `:33-34`.

- [ ] **Step 3: Verify the build compiles**

Run: `npm run build`
Expected: build succeeds, no unused-var or reference errors in `spin-status/route.js`.

- [ ] **Step 4: Commit**

```bash
git add app/api/spin-status/route.js
git commit -m "feat(wheel): spin-status dedupes on customer only"
```

---

## Task 5: `claim_spin` migration — customer-only dedup

**Files:**
- Create: `supabase/migrations/2026-07-24-account-scoped-dedup.sql`

This replaces `claim_spin` with a version identical to `2026-07-21-deposit-gate.sql` except: (a) the fingerprint advisory lock is removed, and (b) the dedup `EXISTS` matches `customer_id` only. The `fingerprint` column is still written to `wheel_spin_log`. `p_fingerprint` stays in the signature (callers unchanged). Same-account protection is preserved by the `customer_id` match + the customer advisory lock.

- [ ] **Step 1: Write the migration file**

```sql
-- Wheel of Fortune — account-scoped dedup (shared-device support)
-- Date: 2026-07-24
-- Safe to run multiple times.
--
-- Replaces claim_spin so dedup keys on customer_id ONLY (not the device
-- fingerprint), letting multiple accounts spin from one shared computer.
-- Fingerprint is still LOGGED for fraud analytics. Anti-farming moves to the
-- deposit-eligibility gate (DEPOSIT_GATE_MODE=enforce). Same-account double-spin
-- is still blocked by the customer_id match + the per-customer advisory lock.
--
-- Wrapped in one transaction so the DROP + CREATE is atomic (no window where
-- claim_spin is missing on the shared prod DB). Apply as ONE statement batch.
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

  -- Dedup on the CUSTOMER only. The fingerprint lock + fingerprint OR-clause
  -- were removed so different accounts on the same device are not blocked.
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

COMMIT;
```

- [ ] **Step 2: Apply + verify on a Supabase branch (NOT prod yet)**

Create a branch and apply the migration there (via the Supabase MCP `create_branch` then `apply_migration`, or the Supabase CLI). Do **not** run against prod in this step — the shared prod DB has a prior load-incident history; verify on the branch first.

- [ ] **Step 3: SQL verification on the branch**

Run this against the branch DB (via MCP `execute_sql`). It proves two different customers on the same fingerprint BOTH get a spin, and the same customer is still blocked:

```sql
-- two accounts, SAME fingerprint, same day/bucket → both succeed
SELECT (public.claim_spin('2026-07-24','vtest','A','fp-shared','1.1.1.1',1,'{}'::jsonb))->>'error' AS a_err;
SELECT (public.claim_spin('2026-07-24','vtest','B','fp-shared','1.1.1.1',1,'{}'::jsonb))->>'error' AS b_err;
-- same account again → blocked
SELECT (public.claim_spin('2026-07-24','vtest','A','fp-other','1.1.1.1',1,'{}'::jsonb))->>'error' AS a_again;
```
Expected: `a_err = NULL`, `b_err = NULL`, `a_again = 'already_spun'`.

Then clean up the test rows on the branch:
```sql
DELETE FROM wheel_spin_log WHERE test_bucket = 'vtest' AND day_date = '2026-07-24';
```

- [ ] **Step 4: Commit the migration file**

```bash
git add supabase/migrations/2026-07-24-account-scoped-dedup.sql
git commit -m "feat(db): claim_spin dedupes on customer only (shared-device)"
```

---

## Task 6: Coordinated rollout

No code changes — this is the deploy/flip sequence. Do the steps in order; each is reversible.

- [ ] **Step 1: Apply the migration to prod**

Apply `supabase/migrations/2026-07-24-account-scoped-dedup.sql` to prod (`blrrcnrhixckfudiojwe`) as a **single** statement batch (it is wrapped in `BEGIN…COMMIT`). This is backward-compatible with the currently-deployed widget (old `spin-status` still over-restricts via fingerprint → no double-spend), so it is safe to apply before the code deploy.

Verify prod has exactly one `claim_spin`:
```sql
SELECT count(*) FROM pg_proc WHERE proname = 'claim_spin';
```
Expected: `1`.

- [ ] **Step 2: Deploy the code**

Merge the branch and deploy to Vercel production (the project's normal deploy). This ships the account-scoped `embed.js`, `WheelWidget`, and `spin-status` together.

- [ ] **Step 3: Live smoke test (two accounts, one browser)**

On one PC/browser, log in as account #1, open the wheel, spin. Then log out, log in as account #2 (same browser), open the wheel. Expected: the pop-up **appears** for account #2 and the spin succeeds. Re-open as account #1: pop-up does **not** re-appear (already spun). Confirm in the DB:
```sql
SELECT customer_id, left(fingerprint,12) AS fp, created_at
FROM wheel_spin_log
WHERE test_bucket = '' AND day_date = '2026-07-24'
ORDER BY created_at DESC LIMIT 5;
```
Expected: two rows, different `customer_id`, same `fp` — both logged.

- [ ] **Step 4: Flip the deposit gate to enforce, with monitoring**

Set `DEPOSIT_GATE_MODE=enforce` in Vercel (Production) and redeploy/restart so it takes effect. This makes the deposit gate the active anti-farming control now that the device block is gone. Then watch:
```sql
-- false-denial pressure: forced losses whose eventual truth says eligible
SELECT decision, enforced, reason, eventual_eligible, count(*)
FROM wheel_deposit_checks
WHERE day_date >= '2026-07-24'
GROUP BY 1,2,3,4 ORDER BY count DESC;
```
Watch `/api/gate-monitor` alerts and the daily digest for the false-denial rate and latency. **Kill switch:** if false-denials spike, set `DEPOSIT_GATE_MODE=shadow` (log only) or `off` (disable) — outcomes revert immediately with no code change.

- [ ] **Step 5: Finalize**

Open a PR (or fast-forward merge to `main` per repo convention), referencing this plan. Note in the PR description that anti-farming now depends on the enforced deposit gate + daily budget cap, and that the device fingerprint is retained as logged fraud-analytics data only.

---

## Self-Review Notes

- **Spec coverage:** account-scoping is applied in all four guard locations (embed.js, WheelWidget, spin-status, claim_spin) — no guard left device-keyed. Anti-farming replacement (enforce) is Task 6 Step 4.
- **Same-account safety:** `claim_spin` still returns `already_spun` for a repeat customer (Task 5 Step 3 verifies), so removing the fingerprint block does not enable same-account double-spins.
- **Type/name consistency:** `hasSpun`/`withSpun` (lib) and `hasSpunToday(customerId)`/`markSpun(customerId)`/`customerIdFromToken` (call sites) are used identically across Tasks 1–3. localStorage schema `{ "<id>": "<day>" }` is identical in `spunCache.mjs` and the inlined `embed.js` version.
- **Rollout ordering:** migration (backward-compatible) → code → enforce flip, each reversible; `DEPOSIT_GATE_MODE=off` is the standing kill switch.
