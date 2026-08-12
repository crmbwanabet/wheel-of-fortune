# 7-Day Deposit Window + FCFS Payout Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen the wheel's deposit-qualification window from 1 to 7 wheel-days, and replace the scattered-positions win mechanism with a first-come-first-served prize queue: every qualifying spinner wins until the day's K2,000 pot is empty, then everyone loses silently until the 06:00 CAT reset.

**Architecture:** Pure-function changes in `lib/` (window math, eligibility predicate, deposit check), one Supabase migration that adds `prize_queue`/`queue_pos` to `wheel_daily_state` and rebuilds `claim_spin` with a `p_payout_mode` switch (default `'positions'` = today's behaviour, so prod is untouched until the env flag flips), and route/telegram/digest plumbing. Everything ships on branch `feat/fcfs-payout-queue`; **never push to main until the Vercel preview is tested and the stakeholder confirms.**

**Tech Stack:** Next.js 14 API routes, `node --test` (`npm test`), Supabase Postgres (plpgsql RPC), project `blrrcnrhixckfudiojwe` (SHARED with the CRM — migrations are prod-visible immediately).

**Spec:** `docs/superpowers/specs/2026-08-12-fcfs-payout-queue-design.md`

**Working directory:** `C:\Users\sbula\wheel-of-fortune` (branch `feat/fcfs-payout-queue`)

---

### Task 1: `qualifyingWindowUtc` in `lib/wheelTime.js`

The window generalises from "the previous wheel-day" to "the last N wheel-days **plus today-so-far**": lower bound = current wheel-day start − N days; upper bound = the spin moment (`nowMs`), so a deposit made today qualifies immediately. The old `previousWheelDayWindowUtc` stays until Task 3 removes its last caller.

**Files:**
- Modify: `lib/wheelTime.js`
- Test: `lib/wheelTime.test.mjs`

- [ ] **Step 1: Add failing tests for `qualifyingWindowUtc`**

Append to `lib/wheelTime.test.mjs`:

```js
import { qualifyingWindowUtc } from './wheelTime.js';

// qualifyingWindowUtc: [current wheel-day start − N days, nowMs] — the upper
// bound is the spin moment so same-day deposits qualify immediately.

test('7-day window mid-afternoon: start is 7 days before today 04:00 UTC, end is now', () => {
  const now = Date.parse('2026-08-12T12:00:00Z'); // 14:00 CAT, wheel-day 2026-08-12
  const { startMs, endMs } = qualifyingWindowUtc(now, 7);
  assert.equal(new Date(startMs).toISOString(), '2026-08-05T04:00:00.000Z');
  assert.equal(endMs, now);
});

test('before 06:00 CAT the wheel-day is still yesterday, so the window shifts back a day', () => {
  const now = Date.parse('2026-08-12T03:59:00Z'); // 05:59 CAT — wheel-day 2026-08-11
  const { startMs, endMs } = qualifyingWindowUtc(now, 7);
  assert.equal(new Date(startMs).toISOString(), '2026-08-04T04:00:00.000Z');
  assert.equal(endMs, now);
});

test('days=1 reproduces the old previous-wheel-day lower bound', () => {
  const now = Date.parse('2026-07-21T12:00:00Z');
  const { startMs } = qualifyingWindowUtc(now, 1);
  assert.equal(new Date(startMs).toISOString(), '2026-07-20T04:00:00.000Z');
});

test('7-day window crosses a month boundary correctly', () => {
  const now = Date.parse('2026-08-03T10:00:00Z'); // wheel-day 2026-08-03
  const { startMs } = qualifyingWindowUtc(now, 7);
  assert.equal(new Date(startMs).toISOString(), '2026-07-27T04:00:00.000Z');
});

test('pre-06:00-CAT Jan 1 rollback normalizes across the year boundary', () => {
  const now = Date.parse('2026-01-01T03:00:00Z'); // wheel-day 2025-12-31
  const { startMs } = qualifyingWindowUtc(now, 7);
  assert.equal(new Date(startMs).toISOString(), '2025-12-24T04:00:00.000Z');
});
```

(Keep the existing `previousWheelDayWindowUtc` tests untouched for now — Task 3 deletes them with the function.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `qualifyingWindowUtc is not a function` (SyntaxError on the named import).

- [ ] **Step 3: Implement `qualifyingWindowUtc`**

Append to `lib/wheelTime.js`:

```js
// Qualifying-deposit window for the FCFS payout model: the last `days` full
// wheel-days PLUS today-so-far. Lower bound = current wheel-day start − days;
// upper bound = the spin moment, so a deposit made today qualifies immediately.
export function qualifyingWindowUtc(nowMs, days = 7) {
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
  return { startMs: curStartMs - days * DAY_MS, endMs: nowMs };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all files).

- [ ] **Step 5: Commit**

```bash
git add lib/wheelTime.js lib/wheelTime.test.mjs
git commit -m "feat(wheelTime): qualifyingWindowUtc for N-day deposit window incl. today-so-far"
```

---

### Task 2: Inclusive upper bound in `lib/depositEligibility.js`

Signature changes from `{ prevStartMs, curStartMs }` (exclusive upper) to `{ startMs, endMs }` (inclusive upper — the bound is "now", and a deposit stamped exactly now qualifies).

**Files:**
- Modify: `lib/depositEligibility.js`
- Test: `lib/depositEligibility.test.mjs`

- [ ] **Step 1: Rewrite the test file for the new window semantics**

Replace the entire contents of `lib/depositEligibility.test.mjs` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasQualifyingDeposit } from './depositEligibility.js';

// Window: last 7 wheel-days + today-so-far = [2026-07-14T04:00Z, 2026-07-21T12:00Z]
// (inclusive upper bound — the bound is the spin moment itself).
const WIN = {
  startMs: Date.parse('2026-07-14T04:00:00Z'),
  endMs: Date.parse('2026-07-21T12:00:00Z'),
};
const rec = (over) => ({ op_type: 'IN-KZ-AIRTEL', status: 'SUCCESS', created_at: '2026-07-16T10:00:00.000Z', ...over });

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
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-14T03:59:59.000Z' })], WIN), false);
});

test('deposit at startMs (inclusive lower bound) qualifies', () => {
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-14T04:00:00.000Z' })], WIN), true);
});

test('deposit exactly at endMs (inclusive upper bound = spin moment) qualifies', () => {
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-21T12:00:00.000Z' })], WIN), true);
});

test('deposit after endMs does not qualify', () => {
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-21T12:00:01.000Z' })], WIN), false);
});

test('deposit made earlier today (same wheel-day as the spin) qualifies', () => {
  assert.equal(hasQualifyingDeposit([rec({ created_at: '2026-07-21T09:00:00.000Z' })], WIN), true);
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

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm test`
Expected: FAIL — the inclusive-upper-bound and renamed-key tests fail (old code destructures `prevStartMs`/`curStartMs`, so every window check returns false).

- [ ] **Step 3: Update the implementation**

Replace the entire contents of `lib/depositEligibility.js` with:

```js
// Pure predicate: does this transaction-history payload contain a qualifying
// deposit for the given UTC window?
//
// A qualifying deposit is a record whose op_type marks a deposit (`IN-*`,
// e.g. "IN-KZ-AIRTEL"; withdrawals are `OUT-*`), whose status is SUCCESS, and
// whose created_at (UTC) falls in [startMs, endMs] — endMs is the spin moment,
// inclusive, so a deposit made seconds before the spin qualifies.
export function hasQualifyingDeposit(data, { startMs, endMs }) {
  if (!Array.isArray(data)) return false;
  return data.some((r) => {
    if (!r || typeof r.op_type !== 'string') return false;
    if (!r.op_type.startsWith('IN-')) return false;
    if (r.status !== 'SUCCESS') return false;
    const t = Date.parse(r.created_at);
    return Number.isFinite(t) && t >= startMs && t <= endMs;
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: `depositEligibility` PASS. `depositCheck.test.mjs` may now FAIL (it still feeds the old window shape via `previousWheelDayWindowUtc` — a record at `2026-07-20T10:00Z` is inside both windows, so most still pass; the timeout tests are unaffected). Any failures here are fixed in Task 3 — do not chase them now.

- [ ] **Step 5: Commit**

```bash
git add lib/depositEligibility.js lib/depositEligibility.test.mjs
git commit -m "feat(eligibility): window keys startMs/endMs with inclusive spin-moment upper bound"
```

---

### Task 3: 7-day window in `lib/depositCheck.js`

Switch to `qualifyingWindowUtc`, widen the API request to `days:"14"` (API accepts only 1/3/7/14/30; 7 wheel-days can reach ~8 calendar days back; Node filters precisely), add env-tunable `windowDays`, and delete the now-unused `previousWheelDayWindowUtc`.

**Files:**
- Modify: `lib/depositCheck.js`
- Modify: `lib/wheelTime.js` (delete old function)
- Test: `lib/depositCheck.test.mjs`, `lib/wheelTime.test.mjs` (delete old tests)

- [ ] **Step 1: Update `lib/depositCheck.test.mjs`**

Replace the constants block at the top (lines 5–6: `NOW` and `IN_WINDOW`) with:

```js
const NOW = Date.parse('2026-07-21T12:00:00Z'); // wheel-day 2026-07-21; 7-day window: [2026-07-14T04:00Z, NOW]
const IN_WINDOW = '2026-07-16T10:00:00.000Z';   // 5 days back — inside the 7-day window
```

Then append these new tests at the bottom of the file:

```js
test('deposit 8 days back is outside the 7-day window -> no_deposit', async () => {
  const { sync } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 1000,
    fetchImpl: fakeFetch(okBody([{ op_type: 'IN-KZ-AIRTEL', status: 'SUCCESS', created_at: '2026-07-13T10:00:00.000Z' }])),
  });
  assert.equal(sync.eligible, false);
  assert.equal(sync.reason, 'no_deposit');
});

test('deposit made earlier today qualifies immediately -> deposit_found', async () => {
  const { sync } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 1000,
    fetchImpl: fakeFetch(okBody([{ op_type: 'IN-KZ-AIRTEL', status: 'SUCCESS', created_at: '2026-07-21T09:00:00.000Z' }])),
  });
  assert.equal(sync.eligible, true);
  assert.equal(sync.reason, 'deposit_found');
});

test('requests days:"14" from the history API (7 wheel-days can span 8 calendar days)', async () => {
  let capturedBody = null;
  const capturingFetch = (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return fakeFetch(okBody([]))(url, opts);
  };
  await checkDepositEligibility({ token: 't', nowMs: NOW, timeoutMs: 1000, fetchImpl: capturingFetch });
  assert.equal(capturedBody.days, '14');
});

test('windowDays override narrows the window', async () => {
  // 5-days-back deposit is inside windowDays=7 (asserted above) but outside windowDays=2.
  const { sync } = await checkDepositEligibility({
    token: 't', nowMs: NOW, timeoutMs: 1000, windowDays: 2,
    fetchImpl: fakeFetch(okBody([{ op_type: 'IN-KZ-AIRTEL', status: 'SUCCESS', created_at: IN_WINDOW }])),
  });
  assert.equal(sync.eligible, false);
  assert.equal(sync.reason, 'no_deposit');
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm test`
Expected: FAIL — `days` is `'3'` not `'14'`, `windowDays` is ignored, and the 8-days-back record wrongly passes/fails per the old 1-day window.

- [ ] **Step 3: Update `lib/depositCheck.js`**

Three changes:

1. Line 1 import and window computation:

```js
import { qualifyingWindowUtc } from './wheelTime.js';
```

2. In the options object, add `windowDays` (after `nowMs`):

```js
  nowMs = Date.now(),
  windowDays = Number(process.env.DEPOSIT_WINDOW_DAYS) || 7,
```

3. Replace `const win = previousWheelDayWindowUtc(nowMs);` with:

```js
  const win = qualifyingWindowUtc(nowMs, windowDays);
```

4. In the fetch call, change the body line to:

```js
        body: JSON.stringify({ days: '14' }),
```

Also update the file's doc-comment near the top if it mentions the previous-wheel-day window (describe: "deposit within the last `windowDays` wheel-days, incl. today-so-far").

- [ ] **Step 4: Delete `previousWheelDayWindowUtc`**

- In `lib/wheelTime.js`: delete the `previousWheelDayWindowUtc` function and its doc-comment (keep `CAT_OFFSET_MS`, `DAY_MS`, `qualifyingWindowUtc`). Update the file header comment to describe the qualifying window.
- In `lib/wheelTime.test.mjs`: delete the 5 old `previousWheelDayWindowUtc` tests and its import; keep the `qualifyingWindowUtc` tests (fold the import into the single import line).

- [ ] **Step 5: Verify nothing still references the old name, run tests**

Run: `grep -rn "previousWheelDayWindowUtc" lib app --include="*.js" --include="*.mjs"`
Expected: no matches.

Run: `npm test`
Expected: PASS (all files).

- [ ] **Step 6: Commit**

```bash
git add lib/depositCheck.js lib/depositCheck.test.mjs lib/wheelTime.js lib/wheelTime.test.mjs
git commit -m "feat(deposit-gate): 7-day qualifying window (DEPOSIT_WINDOW_DAYS), history days:14"
```

---

### Task 4: Prize-queue invariant tests for `generatePrizePool`

`generatePrizePool(algorithmId)` in `lib/algorithms.js` **already returns a shuffled 100-prize array summing to K2,000** — it IS the FCFS queue generator; no new code. But it has zero tests and the queue design leans on its invariants, so pin them down.

**Files:**
- Create: `lib/algorithms.test.mjs`

- [ ] **Step 1: Write the invariant tests**

Create `lib/algorithms.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALGORITHMS, generatePrizePool } from './algorithms.js';

// generatePrizePool doubles as the FCFS prize queue (spec 2026-08-12): a
// shuffled array of exactly 100 prizes totalling exactly K2,000. These
// invariants are what make the queue's budget exact by construction.

for (const [id, algo] of Object.entries(ALGORITHMS)) {
  test(`algorithm ${id} (${algo.name}): pool has exactly 100 prizes summing to K2,000`, () => {
    const pool = generatePrizePool(Number(id));
    assert.equal(pool.length, 100);
    assert.equal(pool.reduce((a, b) => a + b, 0), 2000);
  });

  test(`algorithm ${id} (${algo.name}): shuffle preserves the prize multiset`, () => {
    const pool = generatePrizePool(Number(id));
    const counts = {};
    for (const p of pool) counts[p] = (counts[p] || 0) + 1;
    assert.deepEqual(counts, Object.fromEntries(
      Object.entries(algo.prizes).map(([amount, count]) => [amount, count])
    ));
  });
}

test('unknown algorithm id throws', () => {
  assert.throws(() => generatePrizePool(99), /Unknown algorithm/);
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (these test existing behaviour — if any fail, STOP: the algorithm tables are wrong and the queue design is unsound; report before proceeding).

- [ ] **Step 3: Commit**

```bash
git add lib/algorithms.test.mjs
git commit -m "test(algorithms): pin prize-pool invariants (100 prizes, K2,000 exact) for FCFS queue"
```

---

### Task 5: Migration — `prize_queue` columns + mode-switched `claim_spin`

New columns on `wheel_daily_state`, and `claim_spin` rebuilt with `p_payout_mode` (`'positions'` default = today's behaviour bit-for-bit) and `p_prize_queue`. The queue pop is a single atomic `UPDATE … RETURNING` whose WHERE clause makes exhaustion race-free (0 rows updated = pot empty). **Written to disk here; applied to the DB in Task 9, not now.**

**Files:**
- Create: `supabase/migrations/2026-08-12-fcfs-payout-queue.sql`

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/2026-08-12-fcfs-payout-queue.sql`:

```sql
-- Wheel of Fortune — FCFS payout queue + 7-day deposit window
-- Date: 2026-08-12   Spec: docs/superpowers/specs/2026-08-12-fcfs-payout-queue-design.md
-- Safe to run multiple times.
--
-- Wrapped in a single transaction so the DROP + CREATE of claim_spin is atomic:
-- other sessions block on the function lock and then see the NEW function — they
-- never observe a window where claim_spin is missing (which would be a wheel
-- outage on this shared prod DB). Apply as one statement batch (e.g. execute_sql),
-- NOT split per-statement.
--
-- PROD-SAFETY: p_payout_mode defaults to 'positions', which reproduces the
-- current behaviour exactly. Prod (main) keeps calling with the old argument
-- list and is unaffected until the route passes p_payout_mode='queue'.
BEGIN;

-- 1. Queue storage on the daily-state row.
ALTER TABLE wheel_daily_state
  ADD COLUMN IF NOT EXISTS prize_queue jsonb,
  ADD COLUMN IF NOT EXISTS queue_pos int NOT NULL DEFAULT 0;

-- 2. Replace claim_spin. Drop the old 10-arg overload so exactly one exists.
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
  p_payout_mode text DEFAULT 'positions',
  p_prize_queue jsonb DEFAULT NULL
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
      day_date, test_bucket, algorithm_id, winning_positions, prize_queue, queue_pos,
      total_spins, total_wins, total_budget_spent
    ) VALUES (
      p_day, p_bucket, p_algorithm_id, p_winning_positions, p_prize_queue, 0, 0, 0, 0
    )
    ON CONFLICT (day_date, test_bucket) DO NOTHING;
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS public.%I', v_seqname);
  END IF;

  -- Mode-flip backfill: a day row created before queue mode existed (or before
  -- this migration) has no queue. Adopt the caller's queue on the first
  -- queue-mode spin of the day; no-op once set.
  IF p_payout_mode = 'queue' AND p_prize_queue IS NOT NULL THEN
    UPDATE wheel_daily_state SET prize_queue = p_prize_queue
    WHERE day_date = p_day AND test_bucket = p_bucket AND prize_queue IS NULL;
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
  ELSIF p_payout_mode = 'queue' THEN
    -- FCFS queue: every eligible spin pops the next prize until the pot is
    -- empty. The UPDATE is atomic; its WHERE clause makes exhaustion
    -- race-free (0 rows updated = pot empty = loss). In SET/WHERE, queue_pos
    -- reads the OLD value; RETURNING reads the NEW one, hence queue_pos - 1.
    IF p_eligible THEN
      UPDATE wheel_daily_state
      SET queue_pos = queue_pos + 1,
          total_wins = total_wins + 1,
          total_budget_spent = total_budget_spent + (prize_queue ->> queue_pos)::int
      WHERE day_date = p_day AND test_bucket = p_bucket
        AND prize_queue IS NOT NULL
        AND queue_pos < jsonb_array_length(prize_queue)
      RETURNING (prize_queue ->> (queue_pos - 1))::int, total_wins, total_budget_spent
      INTO v_prize, v_wins, v_budget;
      v_is_win := v_prize IS NOT NULL;
    ELSE
      v_is_win := false;
      -- Telemetry: an ineligible spin while the pot still has prizes is a
      -- blocked would-be win (feeds wheel_deposit_checks.enforced).
      SELECT (prize_queue IS NOT NULL AND queue_pos < jsonb_array_length(prize_queue))
      INTO v_forced_ineligible
      FROM wheel_daily_state
      WHERE day_date = p_day AND test_bucket = p_bucket;
    END IF;
  ELSE
    v_prize := NULLIF(v_map ->> v_spin_number::text, '')::int;
    v_is_win := v_prize IS NOT NULL;
  END IF;

  -- Deposit gate for the positions/forced paths (the queue path is gated
  -- before the pop, so this never fires for it: ineligible ⇒ v_is_win=false).
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

    -- The queue pop already updated the counters (v_wins set by RETURNING);
    -- positions-mode and forced wins update them here.
    IF v_wins IS NULL THEN
      UPDATE wheel_daily_state
      SET total_wins = total_wins + 1,
          total_budget_spent = total_budget_spent + v_prize
      WHERE day_date = p_day AND test_bucket = p_bucket
      RETURNING total_wins, total_budget_spent INTO v_wins, v_budget;
    END IF;
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

GRANT EXECUTE ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, text, jsonb) TO service_role;

COMMIT;
```

- [ ] **Step 2: Sanity-read the diff against the old migration**

Run: `git diff --no-index supabase/migrations/2026-07-21-deposit-gate.sql supabase/migrations/2026-08-12-fcfs-payout-queue.sql`
Expected: the only behavioural deltas are the two new columns, two new params, the backfill block, the `ELSIF p_payout_mode = 'queue'` branch, the `IF v_wins IS NULL` guard around the counter update, and the new GRANT signature. Dedupe locks, sequence init, segment mapping, logging, and the return shape are unchanged.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-08-12-fcfs-payout-queue.sql
git commit -m "feat(db): claim_spin p_payout_mode=queue — atomic FCFS prize-queue pop"
```

---

### Task 6: Telegram win message — queue variant

In queue mode "position N/10000" is meaningless; the win's ordinal (`winsToday`) of 100 is the story.

**Files:**
- Modify: `lib/telegram.js`
- Test: `lib/telegram.test.mjs`

- [ ] **Step 1: Add failing test**

Append to `lib/telegram.test.mjs`:

```js
test('formatWinMessage in queue mode shows win ordinal of 100, not spin position', () => {
  const msg = formatWinMessage({
    customerId: '207978', prizeAmount: 50, winsToday: 3, budgetSpent: 270,
    spinNumber: 2567, payoutMode: 'queue',
  });
  assert.ok(msg.includes('Win #3 of 100'));
  assert.ok(!msg.includes('/10000'));
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `npm test`
Expected: FAIL — message still contains `2567/10000`.

- [ ] **Step 3: Implement**

In `lib/telegram.js`, replace `formatWinMessage` and the `sendWinNotification` signature/pass-through:

```js
// Build the win-notification text. In positions mode `spinNumber` is the
// winner's slot out of WINNABLE_POSITIONS; in queue mode the win ordinal
// (winsToday of 100) is what matters — spin position is meaningless there.
export function formatWinMessage({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber, payoutMode = 'positions' }) {
  const spinLine = payoutMode === 'queue'
    ? `🎡 Win #${winsToday} of 100`
    : `🎡 Spin: ${spinNumber}/${WINNABLE_POSITIONS}`;
  return [
    '🎉 WHEEL WIN',
    `👤 User ID: ${customerId}`,
    `💰 Prize: K${prizeAmount}`,
    spinLine,
    `🕐 Time: ${catTimestamp()}`,
    `📈 Daily: ${winsToday}/100 wins | K${budgetSpent}/K2,000 budget`,
  ].join('\n');
}

export async function sendWinNotification({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber, payoutMode }) {
  const message = formatWinMessage({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber, payoutMode });
```

(The rest of `sendWinNotification` is unchanged.)

- [ ] **Step 4: Run tests to verify pass (incl. the existing positions-mode test)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/telegram.js lib/telegram.test.mjs
git commit -m "feat(telegram): queue-mode win message shows win ordinal, not spin position"
```

---

### Task 7: Spin route — mode plumbing

Route reads `WHEEL_PAYOUT_MODE`, always sends the prize queue to `claim_spin` (day-init stores both structures, so a mid-day mode flip works in both directions), and forwards `payoutMode` to Telegram. No new tests — this file has no test harness; behaviour is covered by the SQL verification (Task 9) and the preview checklist (Task 10).

**Files:**
- Modify: `app/api/spin/route.js`

- [ ] **Step 1: Add the mode config**

In `app/api/spin/route.js`, extend the import from `@/lib/algorithms` (line 5–9) to include `generatePrizePool`:

```js
import {
  getWheelDayDate,
  pickAlgorithm,
  buildWinningMap,
  generatePrizePool,
} from '@/lib/algorithms';
```

After the `DEPOSIT_CHECK_BG_CAP_MS` line (line 25), add:

```js
// Payout mode: 'positions' = scattered winning slots (legacy); 'queue' = FCFS
// prize queue — every eligible spin wins until the day's pot is empty. See
// spec 2026-08-12-fcfs-payout-queue-design.md. Env-flip = instant rollback.
const WHEEL_PAYOUT_MODE = process.env.WHEEL_PAYOUT_MODE === 'queue' ? 'queue' : 'positions';
```

- [ ] **Step 2: Generate and pass the queue**

After `const winningPositions = buildWinningMap(algorithmId);` (line 88), add:

```js
  // Shuffled 100-prize queue (K2,000 exact). Sent on every spin, but only the
  // day's FIRST spin persists it (day-init); both structures are stored so a
  // mid-day WHEEL_PAYOUT_MODE flip works in either direction.
  const prizeQueue = generatePrizePool(algorithmId);
```

In the `supabase.rpc('claim_spin', {...})` call, add two params after `p_eligible: effectiveEligible,`:

```js
    p_payout_mode: WHEEL_PAYOUT_MODE,
    p_prize_queue: prizeQueue,
```

- [ ] **Step 3: Forward the mode to Telegram**

In the `sendWinNotification({ ... })` call, add after `spinNumber: result.spin_number,`:

```js
        payoutMode: WHEEL_PAYOUT_MODE,
```

- [ ] **Step 4: Build check + tests**

Run: `npm test`
Expected: PASS.
Run: `npm run build`
Expected: compiles with no errors (route has no unit harness; this catches import/syntax slips).

- [ ] **Step 5: Commit**

```bash
git add app/api/spin/route.js
git commit -m "feat(spin): WHEEL_PAYOUT_MODE plumbing — send prize queue + mode to claim_spin"
```

---

### Task 8: Digest queue stats + env docs

**Files:**
- Modify: `app/api/digest/route.js`
- Modify: `.env.example`

- [ ] **Step 1: Queue-aware digest**

In `app/api/digest/route.js`, inside the `else` branch (after `const beyond = ...` block, replacing the `spinsLine`/`text` assignment), make the block mode-aware:

```js
      const queueMode = process.env.WHEEL_PAYOUT_MODE === 'queue';
      let spinsLine;
      let exhaustLine = null;
      if (queueMode) {
        spinsLine = `Spins: ${spins}`;
        // Pot exhausted = the 100th win. Its timestamp tells us when the day's
        // K2,000 ran out (spec: expected ~06:45 CAT at current traffic).
        if ((state?.total_wins ?? 0) >= 100) {
          const { data: hundredth } = await supabase
            .from('wheel_spin_log')
            .select('created_at')
            .eq('day_date', day).eq('test_bucket', '').eq('won', true)
            .order('created_at', { ascending: true })
            .range(99, 99);
          if (hundredth?.[0]?.created_at) {
            const catMs = Date.parse(hundredth[0].created_at) + 2 * 60 * 60 * 1000;
            exhaustLine = `Pot exhausted at ${new Date(catMs).toISOString().slice(11, 16)} CAT`;
          }
        }
      } else {
        const beyond = Math.max(0, spins - WINNABLE_POSITIONS);
        spinsLine = beyond > 0
          ? `Spins: ${spins} (first ${WINNABLE_POSITIONS} winnable, ${beyond} past cap)`
          : `Spins: ${spins} / ${WINNABLE_POSITIONS} winnable`;
      }
      text = [
        `📊 Wheel daily digest — ${day}`,
        spinsLine,
        `Wins: ${state?.total_wins ?? 0} → K${state?.total_budget_spent ?? 0} / K2,000 budget`,
        exhaustLine,
        `(errors delivered live; see alerts)`,
      ].filter(Boolean).join('\n');
```

(Delete the old `const beyond = ...` / `const spinsLine = ...` / `text = [...]` lines this replaces.)

- [ ] **Step 2: Document the new env vars**

In `.env.example`, after the `BWANA_API_BASE` line, add:

```bash
# --- FCFS payout queue (spec 2026-08-12) ---
# positions = scattered winning slots (legacy, default); queue = every eligible
# spin wins until the K2,000 pot is empty, then silent losses until 06:00 CAT.
WHEEL_PAYOUT_MODE=positions
# Qualifying-deposit window in wheel-days (deposit within the last N wheel-days
# OR today-so-far makes a spin eligible to win).
DEPOSIT_WINDOW_DAYS=7
```

- [ ] **Step 3: Build check + tests**

Run: `npm test && npm run build`
Expected: PASS / clean build.

- [ ] **Step 4: Commit**

```bash
git add app/api/digest/route.js .env.example
git commit -m "feat(digest): queue-mode stats incl. pot-exhaustion time; document new env vars"
```

---

### Task 9: Apply migration to the shared DB + SQL verification

The migration is prod-safe by construction (defaults = current behaviour) but the DB is shared with the live wheel — apply it as ONE batch and verify both modes immediately, using a far-future `day_date` + dedicated test bucket so real rows are untouched.

**Tools:** Supabase MCP (`execute_sql`, project_id `blrrcnrhixckfudiojwe`). If the MCP tools are unavailable, STOP and ask the user rather than improvising another path.

- [ ] **Step 1: Apply the migration**

Execute the full contents of `supabase/migrations/2026-08-12-fcfs-payout-queue.sql` via `execute_sql` as a single batch (the file is BEGIN/COMMIT-wrapped; do NOT split it).
Expected: success, no rows returned.

- [ ] **Step 2: Verify prod default is unchanged (positions mode, defaults)**

```sql
SELECT claim_spin(
  '2099-01-01'::date, 'fcfs-verify', 'verify-cust-1', NULL, '127.0.0.1',
  1, '{"1": 10}'::jsonb, true, NULL, true
) AS r;
```

Expected: `{"win": true, "prize_amount": 10, "segment_index": 0, "spin_number": 1, ...}` — the 10-arg legacy call shape still works and spin 1 hits position "1".

- [ ] **Step 3: Verify queue mode — pop order, gate, exhaustion**

```sql
SELECT
  claim_spin('2099-01-02'::date, 'fcfs-verify', 'q1', NULL, '127.0.0.1', 1, '{}'::jsonb, true, NULL, true,  'queue', '[10, 200, 20]'::jsonb) AS spin1_eligible_wins_10,
  claim_spin('2099-01-02'::date, 'fcfs-verify', 'q2', NULL, '127.0.0.1', 1, '{}'::jsonb, true, NULL, false, 'queue', '[10, 200, 20]'::jsonb) AS spin2_ineligible_loses,
  claim_spin('2099-01-02'::date, 'fcfs-verify', 'q3', NULL, '127.0.0.1', 1, '{}'::jsonb, true, NULL, true,  'queue', '[10, 200, 20]'::jsonb) AS spin3_eligible_wins_200,
  claim_spin('2099-01-02'::date, 'fcfs-verify', 'q4', NULL, '127.0.0.1', 1, '{}'::jsonb, true, NULL, true,  'queue', '[10, 200, 20]'::jsonb) AS spin4_eligible_wins_20,
  claim_spin('2099-01-02'::date, 'fcfs-verify', 'q5', NULL, '127.0.0.1', 1, '{}'::jsonb, true, NULL, true,  'queue', '[10, 200, 20]'::jsonb) AS spin5_exhausted_loses;
```

Expected, in order:
1. `win:true, prize_amount:10` (queue[0])
2. `win:false, forced_loss_ineligible:true` (gated; pot NOT consumed)
3. `win:true, prize_amount:200` (queue[1] — the ineligible spin did not pop)
4. `win:true, prize_amount:20` (queue[2])
5. `win:false, forced_loss_ineligible:false` (pot empty — plain loss)

Then check the state row:

```sql
SELECT queue_pos, total_wins, total_budget_spent
FROM wheel_daily_state WHERE day_date = '2099-01-02' AND test_bucket = 'fcfs-verify';
```

Expected: `queue_pos=3, total_wins=3, total_budget_spent=230`.

- [ ] **Step 4: Verify mode-flip backfill (day initialized without a queue)**

```sql
SELECT claim_spin('2099-01-03'::date, 'fcfs-verify', 'b1', NULL, '127.0.0.1', 1, '{"1": 10}'::jsonb, true, NULL, true) AS init_positions;
SELECT claim_spin('2099-01-03'::date, 'fcfs-verify', 'b2', NULL, '127.0.0.1', 1, '{}'::jsonb, true, NULL, true, 'queue', '[50]'::jsonb) AS flip_to_queue;
```

Expected: first call wins K10 via positions; second call wins K50 — the NULL `prize_queue` was backfilled and popped.

- [ ] **Step 5: Clean up verification rows**

```sql
DELETE FROM wheel_spin_log WHERE test_bucket = 'fcfs-verify';
DELETE FROM wheel_daily_state WHERE test_bucket = 'fcfs-verify';
DROP SEQUENCE IF EXISTS public.wheel_seq_20990101_%s; -- use the actual seq names:
-- SELECT sequencename FROM pg_sequences WHERE sequencename LIKE 'wheel_seq_2099%';
-- then DROP SEQUENCE each one returned.
```

Expected: 0 rows remain for the bucket (`SELECT count(*) FROM wheel_spin_log WHERE test_bucket='fcfs-verify'` → 0).

- [ ] **Step 6: Confirm live prod is healthy post-migration**

```sql
SELECT count(*) AS spins_last_10min,
       count(*) FILTER (WHERE won) AS wins
FROM wheel_spin_log
WHERE test_bucket = '' AND created_at > now() - interval '10 minutes';
```

Expected: a non-zero spin count comparable to normal traffic (~30–60/10min daytime) and no error spike in `wheel_error_log` (`SELECT count(*) FROM wheel_error_log WHERE created_at > now() - interval '10 minutes'` → 0 or near it). If spins flatline: re-check the function exists and REPORT IMMEDIATELY.

---

### Task 10: Push branch → preview → stakeholder test gate

**⚠️ NEVER push to `main` or merge in this task. The stakeholder must test on the preview page first (their explicit instruction, 2026-08-12).**

- [ ] **Step 1: Push the feature branch only**

```bash
git push -u origin feat/fcfs-payout-queue
```

Expected: branch pushed; Vercel builds a preview deployment automatically. Get its URL from the Vercel dashboard or `vercel ls` (deployment for branch `feat/fcfs-payout-queue`).

- [ ] **Step 2: Set preview-scoped env vars**

Preview must run queue mode; production keeps `positions` (var absent = default). Preview-scope only:

```bash
echo "queue" | vercel env add WHEEL_PAYOUT_MODE preview
echo "7" | vercel env add DEPOSIT_WINDOW_DAYS preview
```

Then redeploy the preview so the vars take effect: `git commit --allow-empty -m "chore: redeploy preview" && git push`.
(If the CLI is not linked, ask the user to add both vars in Vercel dashboard → Settings → Environment Variables → Preview, then redeploy.)

- [ ] **Step 3: Preview functional test (test-mode, dedicated bucket)**

Against the preview URL, with `WHEEL_TEST_TOKEN` from the Vercel project env (ask the user if unavailable). PowerShell:

```powershell
$h = @{ 'Content-Type' = 'application/json'; 'x-wheel-test-token' = '<WHEEL_TEST_TOKEN>' }
1..8 | ForEach-Object {
  $body = @{ test = $true; customerId = "preview-q$_"; testBucket = 'preview-fcfs'; eligible = $true } | ConvertTo-Json
  (Invoke-WebRequest -Uri 'https://<preview-url>/api/spin' -Method POST -Headers $h -Body $body).Content
}
```

Note: test-mode requests skip the deposit API; check how the route derives test eligibility — the current route always passes `effectiveEligible=true` for test traffic, which is exactly what queue-mode verification needs (every test spin should win until the pot empties).

Expected: **every spin returns `win:true`** with prizes drawn in queue order until 100 wins (or spot-check ~8 spins then verify counters in SQL: `SELECT queue_pos, total_wins, total_budget_spent FROM wheel_daily_state WHERE test_bucket='preview-fcfs'` — `queue_pos` = number of spins made, budget = sum of prizes returned).

- [ ] **Step 3b: Concurrency burst (no double-claimed queue slot)**

Fire 30 spins in parallel at the preview (fresh bucket `preview-fcfs-burst`), then verify by SQL that no queue slot was claimed twice:

```powershell
$h = @{ 'Content-Type' = 'application/json'; 'x-wheel-test-token' = '<WHEEL_TEST_TOKEN>' }
$jobs = 1..30 | ForEach-Object {
  $body = @{ test = $true; customerId = "burst-$_"; testBucket = 'preview-fcfs-burst' } | ConvertTo-Json
  Start-ThreadJob { param($u,$h,$b) (Invoke-WebRequest -Uri $u -Method POST -Headers $h -Body $b).Content } -ArgumentList 'https://<preview-url>/api/spin', $h, $body
}
$jobs | Receive-Job -Wait
```

Then:

```sql
SELECT s.queue_pos, s.total_wins, s.total_budget_spent,
       (SELECT count(*) FROM wheel_spin_log l WHERE l.test_bucket = 'preview-fcfs-burst' AND l.won) AS logged_wins,
       (SELECT sum(prize_amount) FROM wheel_spin_log l WHERE l.test_bucket = 'preview-fcfs-burst' AND l.won) AS logged_budget
FROM wheel_daily_state s WHERE s.test_bucket = 'preview-fcfs-burst';
```

Expected: `queue_pos = total_wins = logged_wins` and `total_budget_spent = logged_budget` — counters and log agree exactly; any mismatch means a double-claimed slot (STOP and report).

- [ ] **Step 4: Clean up preview test rows**

```sql
DELETE FROM wheel_spin_log WHERE test_bucket IN ('preview-fcfs', 'preview-fcfs-burst');
DELETE FROM wheel_daily_state WHERE test_bucket IN ('preview-fcfs', 'preview-fcfs-burst');
-- plus the day's sequence: SELECT sequencename FROM pg_sequences WHERE sequencename LIKE 'wheel_seq_%' — drop the one whose md5 bucket-hash matches 'preview-fcfs' (created today).
```

- [ ] **Step 5: Hand the preview to the stakeholder — HARD STOP**

Report to the user:
- Preview URL + confirmation that queue mode is live on it
- SQL + preview test results (pop order, gate, exhaustion, backfill)
- Reminder that prod is still on positions mode and main is untouched

**Wait for the stakeholder's explicit approval on the preview page.** Only after approval: merge to main (fast-forward or PR per their preference), and only after THAT flip `WHEEL_PAYOUT_MODE=queue` + `DEPOSIT_WINDOW_DAYS=7` in the **Production** env scope as a separate, reversible step.

---

## Rollback

- **Anytime, instantly:** set Production `WHEEL_PAYOUT_MODE=positions` (or remove the var) → legacy behaviour, no DB change needed. Both structures are stored per day, so a mid-day flip in either direction keeps working.
- **Deposit window only:** set `DEPOSIT_WINDOW_DAYS=1` → old 1-day rule (window math is equivalent for the gate's purposes; upper bound now includes today-so-far, which is strictly more generous).
- **Full DB revert (only if the migration itself misbehaves):** re-apply `supabase/migrations/2026-07-21-deposit-gate.sql` (restores the 10-arg `claim_spin`), then `ALTER TABLE wheel_daily_state DROP COLUMN prize_queue, DROP COLUMN queue_pos;` — but note the route on this branch passes the two extra named params, so only do this while prod runs main.
