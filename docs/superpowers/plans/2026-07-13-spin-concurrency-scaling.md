# Spin Concurrency Scaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/api/spin` sustain 1,000 concurrent requests (stretch: 10,000) by removing the single-row counter lock, while preserving the exact 100-winner / K2,000-per-day guarantee.

**Architecture:** Replace the contended `UPDATE wheel_daily_state SET total_spins=total_spins+1` with a per-day Postgres **sequence** (`nextval`, lock-free under concurrency). Fold day-init into `claim_spin`, bound each call with a `statement_timeout` so saturation sheds fast as `server_busy`, move the Telegram alert off the response path, and colocate the function with the DB. Everything is validated on a throwaway Supabase branch before touching the live CRM database.

**Tech Stack:** Next.js 14.2.35 (App Router, Node runtime) on Vercel, `@supabase/supabase-js` 2.x over PostgREST, Supabase Postgres 17 (project `blrrcnrhixckfudiojwe`, region eu-west-1), `@vercel/functions` for `waitUntil`.

**Reference spec:** `docs/superpowers/specs/2026-07-13-spin-concurrency-scaling-design.md`

---

## File / object map

| Path or DB object | Responsibility | Change |
|---|---|---|
| `claim_spin` (Postgres function) | Atomic per-spin claim | **Rewrite**: sequence ordinal, folded day-init, win-only counter update, `statement_timeout` |
| `wheel_seq_<yyyymmdd>_<8hex>` (Postgres sequences) | Per-day spin ordinal source | **New**, created on first spin of the day |
| `drop_stale_wheel_sequences()` (Postgres function) | Housekeeping | **New**, dropped by daily cron |
| `ensure_daily_state` (Postgres function) | Old day-init | **Left in place, now unused** (avoids deploy-ordering break) |
| `app/api/spin/route.js` | HTTP spin handler | Drop separate ensure call; new `claim_spin` args; `server_busy` on query-cancel; `waitUntil` Telegram; region |
| `vercel.json` | Vercel serverless config | **New**: pin function region to `dub1` |
| `components/WheelWidget.jsx` | Widget UI | Retry the spin fetch once on network error/timeout |
| `package.json` | Deps | Add `@vercel/functions` |
| `scripts/concurrency-verify.mjs` | Branch load test + correctness assertions | **New** |

**Guardrail throughout:** every migration in this plan is applied to a **Supabase branch first** (Task 1), load-tested (Task 8), and only promoted to production in Task 9. Never run a ramp test against the production database directly — it is shared with the live CRM.

---

## Task 1: Create a Supabase branch for safe iteration

**Files:** none (infrastructure).

- [ ] **Step 1: Create the branch**

Use the Supabase MCP tool `create_branch` on project `blrrcnrhixckfudiojwe` with name `spin-scaling`. This clones schema + migrations into an isolated database. Note the returned branch `project_ref` / connection details — all Task 2–8 migrations and load tests target the **branch**, not production.

- [ ] **Step 2: Record the branch ref**

Write the branch project ref into this plan file under Task 1 (replace `<BRANCH_REF>` everywhere below) so later tasks are unambiguous.

- [ ] **Step 3: Commit the note**

```bash
git add docs/superpowers/plans/2026-07-13-spin-concurrency-scaling.md
git commit -m "chore: record supabase branch ref for spin-scaling work"
```

---

## Task 2: Rewrite `claim_spin` to use a per-day sequence

**Files:**
- Migration (applied to branch `<BRANCH_REF>` via MCP `apply_migration`, name `claim_spin_sequence_v2`)

- [ ] **Step 1: Apply the migration to the branch**

Apply this exact SQL with MCP `apply_migration` (project = `<BRANCH_REF>`, name = `claim_spin_sequence_v2`):

```sql
-- New claim_spin: ordinal from a per-day sequence instead of a row-lock UPDATE.
-- Folds day-init (state row + sequence) in; updates reporting counters on wins only.
-- Dedupe runs BEFORE consuming a sequence value so duplicates waste no ordinal.
DROP FUNCTION IF EXISTS public.claim_spin(date, text, text, text, text, boolean, integer);

CREATE OR REPLACE FUNCTION public.claim_spin(
  p_day date,
  p_bucket text,
  p_customer text,
  p_fingerprint text,
  p_ip text,
  p_algorithm_id integer,
  p_winning_positions jsonb,
  p_skip_dedupe boolean DEFAULT false,
  p_force_prize integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
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
BEGIN
  -- Deterministic, identifier-safe sequence name with a parseable date prefix.
  v_seqname := format('wheel_seq_%s_%s', to_char(p_day, 'YYYYMMDD'), substr(md5(p_bucket), 1, 8));

  -- Day-init: only the first spins of the day pay for this. After the state row
  -- exists, the NOT EXISTS short-circuits and no lock/DDL runs. The advisory lock
  -- serializes the initial racers so CREATE SEQUENCE IF NOT EXISTS is race-safe.
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

  -- Dedupe (skipped in test mode). Per-key advisory locks: different customers
  -- never contend. Done before nextval so a duplicate consumes no ordinal.
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

  -- Lock-free ordinal. Gaps (from aborted txns) are acceptable: at most a winning
  -- slot goes unclaimed, so payout stays <= budget. Never exceeds it.
  EXECUTE format('SELECT nextval(%L)', 'public.' || v_seqname) INTO v_spin_number;

  -- Static winning map for the day (indexed read, no lock).
  SELECT winning_positions INTO v_map
  FROM wheel_daily_state
  WHERE day_date = p_day AND test_bucket = p_bucket;

  IF v_map IS NULL THEN
    RETURN jsonb_build_object('error', 'no_state');
  END IF;

  -- Win lookup: forced (test) or map lookup by ordinal.
  IF p_force_prize IS NOT NULL THEN
    v_prize := p_force_prize;
    v_is_win := true;
  ELSE
    v_prize := NULLIF(v_map ->> v_spin_number::text, '')::int;
    v_is_win := v_prize IS NOT NULL;
  END IF;

  IF v_is_win THEN
    v_segment := CASE v_prize
      WHEN 10 THEN 0 WHEN 50 THEN 2 WHEN 200 THEN 4 WHEN 20 THEN 6 WHEN 100 THEN 8
      ELSE NULL END;
    IF v_segment IS NULL THEN
      RAISE EXCEPTION 'Unknown prize amount: %', v_prize;
    END IF;

    -- Reporting counters updated on wins only (~100/day) — negligible contention.
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
    'budget_today', v_budget
  );
END;
$function$;

-- Admission control: bound every call so saturation aborts fast (57014) instead
-- of piling up long-held locks that could starve the shared CRM DB.
ALTER FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer)
  SET statement_timeout = '5000ms';
```

- [ ] **Step 2: Smoke-test the new function directly on the branch**

Run with MCP `execute_sql` (project = `<BRANCH_REF>`):

```sql
select public.claim_spin(
  current_date, 'plan-smoke', 'cust-1', 'fp-1', '127.0.0.1',
  5, '{"1":10,"2":20}'::jsonb, true, null
);
```

Expected: a JSON row with `spin_number` = 1 and `win` = true, `prize_amount` = 10 (ordinal 1 is in the map). Run it again → `spin_number` = 2, `prize_amount` = 20. A third call → `win` = false (ordinal 3 not in map).

- [ ] **Step 3: Verify the sequence exists and is parseable**

```sql
select relname from pg_class
where relkind = 'S' and relname like 'wheel_seq_%';
```

Expected: a sequence named `wheel_seq_<today>_<8hex>`.

- [ ] **Step 4: Commit a copy of the migration SQL into the repo for traceability**

Save the SQL above to `supabase/migrations/` if that folder exists; otherwise skip (MCP-applied migrations are tracked in Supabase). Then:

```bash
git add -A
git commit -m "feat(db): claim_spin v2 — per-day sequence ordinal, folded init, statement_timeout"
```

---

## Task 3: Add sequence housekeeping

**Files:**
- Migration on branch `<BRANCH_REF>`, name `drop_stale_wheel_sequences`

- [ ] **Step 1: Apply the cleanup function**

```sql
-- Drops wheel_seq_YYYYMMDD_* sequences older than the retention window.
-- The date is parsed from the sequence name (positions 11-18).
CREATE OR REPLACE FUNCTION public.drop_stale_wheel_sequences(p_keep_days integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
  r record;
  v_dropped int := 0;
  v_seq_date date;
BEGIN
  FOR r IN
    SELECT relname FROM pg_class
    WHERE relkind = 'S' AND relname ~ '^wheel_seq_[0-9]{8}_'
  LOOP
    BEGIN
      v_seq_date := to_date(substr(r.relname, 11, 8), 'YYYYMMDD');
    EXCEPTION WHEN others THEN
      CONTINUE; -- unparseable name, leave it alone
    END;
    IF v_seq_date < current_date - p_keep_days THEN
      EXECUTE format('DROP SEQUENCE IF EXISTS public.%I', r.relname);
      v_dropped := v_dropped + 1;
    END IF;
  END LOOP;
  RETURN v_dropped;
END;
$function$;
```

- [ ] **Step 2: Verify it runs without error**

```sql
select public.drop_stale_wheel_sequences(3);
```

Expected: returns `0` (nothing stale yet).

- [ ] **Step 3: Schedule it (pg_cron)**

Check whether `pg_cron` is enabled: MCP `list_extensions` on `<BRANCH_REF>`. If present, schedule daily at 05:00 UTC (before the 04:00-UTC/06:00-CAT reset window is well clear):

```sql
select cron.schedule('drop-stale-wheel-seqs', '0 5 * * *', $$select public.drop_stale_wheel_sequences(3)$$);
```

If `pg_cron` is not enabled, note in the plan that cleanup must be triggered another way (e.g. a Vercel cron hitting an admin route) and leave the function in place for manual/looped invocation. Do not enable new extensions without confirming with the user.

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "feat(db): drop_stale_wheel_sequences housekeeping + daily schedule"
```

---

## Task 4: Update the spin route to the new contract

**Files:**
- Modify: `app/api/spin/route.js`

- [ ] **Step 1: Replace the ensure+claim block**

In `app/api/spin/route.js`, **remove** the entire `ensure_daily_state` RPC call block, and change the `claim_spin` call to the new signature (note the new `p_algorithm_id` / `p_winning_positions` args and reordered optional args). Replace the section from the `// Idempotent day init` comment through the end of the `claim_spin` error handling with:

```javascript
  const supabase = getSupabase();

  // Atomic claim — day-init is folded into claim_spin (single round trip).
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
  });

  if (claimErr) {
    // 57014 = statement_timeout (admission control shedding load). Tell the client
    // to back off rather than surfacing a hard error.
    if (claimErr.code === '57014') {
      return NextResponse.json({ error: 'server_busy' }, { status: 503 });
    }
    console.error('[spin] claim_spin failed:', claimErr);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
  if (!result) {
    console.error('[spin] claim_spin returned no result');
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  if (result.error === 'already_spun') {
    return NextResponse.json({ error: 'already_spun' });
  }
  if (result.error) {
    console.error('[spin] RPC returned error:', result.error);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
```

Leave the `algorithmId` / `winningPositions` computation (`pickAlgorithm()` / `buildWinningMap()`) exactly as it is above this block — they are still computed per request and passed in; `claim_spin` only consumes them on the first spin of the day.

- [ ] **Step 2: Pin the function region (route segment config)**

At the top of `app/api/spin/route.js`, directly under the imports, add:

```javascript
// Colocate with the Supabase database (eu-west-1 / Dublin) to remove
// cross-region round trips from every query on the hot path.
export const preferredRegion = ['dub1'];
export const dynamic = 'force-dynamic';
```

(Region is also enforced at the platform level in Task 6 via `vercel.json`; this documents intent at the route.)

- [ ] **Step 3: Verify the build compiles**

Run: `npx next build`
Expected: `✓ Compiled successfully` and `/api/spin` listed as a dynamic route.

- [ ] **Step 4: Commit**

```bash
git add app/api/spin/route.js
git commit -m "feat(spin): call claim_spin v2, shed load as server_busy, pin region"
```

---

## Task 5: Move the Telegram notification off the response path

**Files:**
- Modify: `package.json` (add `@vercel/functions`)
- Modify: `app/api/spin/route.js`

- [ ] **Step 1: Add the dependency**

Run: `npm install @vercel/functions`
Expected: `@vercel/functions` appears under `dependencies` in `package.json`.

- [ ] **Step 2: Import `waitUntil`**

At the top of `app/api/spin/route.js`, add to the imports:

```javascript
import { waitUntil } from '@vercel/functions';
```

- [ ] **Step 3: Replace the awaited Telegram send**

Replace the existing win-notification block:

```javascript
  if (result.win && !isTest) {
    await sendWinNotification({
      customerId: cleanId,
      prizeAmount: result.prize_amount,
      winsToday: result.wins_today,
      budgetSpent: result.budget_today,
    }).catch(err => console.error('[spin] Telegram notify failed:', err?.message));
  }
```

with a post-response dispatch so the spinner returns immediately:

```javascript
  if (result.win && !isTest) {
    // Fire after the response is sent. waitUntil keeps the serverless function
    // alive for it without blocking the spin result.
    waitUntil(
      sendWinNotification({
        customerId: cleanId,
        prizeAmount: result.prize_amount,
        winsToday: result.wins_today,
        budgetSpent: result.budget_today,
      }).catch(err => console.error('[spin] Telegram notify failed:', err?.message))
    );
  }
```

- [ ] **Step 4: Verify the build**

Run: `npx next build`
Expected: `✓ Compiled successfully`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json app/api/spin/route.js
git commit -m "perf(spin): send Telegram win alert via waitUntil, off the response path"
```

---

## Task 6: Pin the serverless region at the platform level

**Files:**
- Create: `vercel.json`

- [ ] **Step 1: Create `vercel.json`**

```json
{
  "functions": {
    "app/api/spin/route.js": { "maxDuration": 15 }
  },
  "regions": ["dub1"]
}
```

- [ ] **Step 2: Confirm the Vercel plan allows region selection**

Run: `npx vercel project ls` and check the plan, or inspect a deployment. If the account is Hobby (region-locked), region pinning via `regions` is ignored — note this in the plan and rely on the other optimizations; do not block. If Pro, `dub1` applies.

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "chore(vercel): pin spin function to dub1 (colocated with Supabase eu-west-1)"
```

---

## Task 7: Retry the spin once on the client

**Files:**
- Modify: `components/WheelWidget.jsx`

- [ ] **Step 1: Find the spin fetch**

Locate the `fetch('/api/spin', ...)` call in `components/WheelWidget.jsx` (the handler that submits a spin and reads `{ win, segmentIndex, prize }`).

- [ ] **Step 2: Wrap it in a single retry helper**

Add this helper near the other module-scope helpers (after `isAllowedAuthOrigin`), and use it in place of the direct `fetch('/api/spin', ...)`:

```javascript
// One retry on network error / 503 server_busy — a timed-out spin is safe to
// retry because the server dedupes (returns already_spun if the first committed).
async function postSpinWithRetry(body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('/api/spin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 503 && attempt === 0) {
        await new Promise(r => setTimeout(r, 600));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 600));
        continue;
      }
      throw err;
    }
  }
}
```

Replace the existing spin `fetch(...)` with `await postSpinWithRetry(spinBody)` where `spinBody` is the object currently passed as the fetch `body` (token + fingerprint, or test-mode fields). Keep the existing response handling (`.json()`, win/loss branching) unchanged.

- [ ] **Step 3: Verify the build**

Run: `npx next build`
Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Commit**

```bash
git add components/WheelWidget.jsx
git commit -m "feat(widget): retry spin once on network error / server_busy"
```

---

## Task 8: Load-test on the branch (ramp 100 -> 1,000 -> 10,000)

**Files:**
- Create: `scripts/concurrency-verify.mjs`

- [ ] **Step 1: Write the verifier script**

Create `scripts/concurrency-verify.mjs`:

```javascript
#!/usr/bin/env node
/**
 * Concurrency verifier. Fires N spins at a target concurrency into an isolated
 * test bucket against a BRANCH deployment, then asserts correctness from the DB.
 *
 * Usage:
 *   node --env-file=.env.branch scripts/concurrency-verify.mjs --url <branch-url> --spins 2000 --concurrency 1000
 *
 * Env: WHEEL_TEST_TOKEN (branch's token). Correctness assertions are printed;
 * DB-side checks are run separately via the SQL in Step 3.
 */
const args = process.argv.slice(2);
const getArg = (n, fb) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i+1] ? args[i+1] : fb; };
const BASE = getArg('url', 'https://wheel-of-fortune-roan.vercel.app');
const SPINS = parseInt(getArg('spins', '2000'));
const CONC = parseInt(getArg('concurrency', '1000'));
const BUCKET = 'conc-' + Date.now().toString(36);
const TOKEN = process.env.WHEEL_TEST_TOKEN;
if (!TOKEN) { console.error('WHEEL_TEST_TOKEN required'); process.exit(1); }

async function spin(i) {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/api/spin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wheel-test-token': TOKEN },
      body: JSON.stringify({
        customerId: `c_${BUCKET}_${i}`, fingerprint: `f_${BUCKET}_${i}`,
        test: true, testBucket: BUCKET, skipDedupe: true,
      }),
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, err: data?.error, ms: performance.now() - t0 };
  } catch (e) { return { status: 0, err: e.message, ms: performance.now() - t0 }; }
}

async function pool(n, conc) {
  const out = []; let next = 0;
  const worker = async () => { while (next < n) { const i = next++; out[i] = await spin(i); } };
  await Promise.all(Array.from({ length: conc }, worker));
  return out;
}

console.log(`Bucket ${BUCKET} — ${SPINS} spins @ concurrency ${CONC} -> ${BASE}`);
const t0 = performance.now();
const r = await pool(SPINS, CONC);
const secs = (performance.now() - t0) / 1000;
const ok = r.filter(x => x.status === 200 && !x.err);
const busy = r.filter(x => x.err === 'server_busy' || x.status === 503);
const failed = r.filter(x => x.status === 0 || (x.status >= 500 && x.status !== 503));
const lat = r.map(x => x.ms).sort((a, b) => a - b);
const pct = p => lat[Math.floor(lat.length * p)]?.toFixed(0);
console.log(`  ok=${ok.length} server_busy=${busy.length} failed=${failed.length}`);
console.log(`  rps=${(ok.length/secs).toFixed(0)} p50=${pct(0.5)}ms p95=${pct(0.95)}ms p99=${pct(0.99)}ms max=${lat.at(-1)?.toFixed(0)}ms`);
console.log(`  BUCKET=${BUCKET}  (use in the SQL correctness check)`);
```

- [ ] **Step 2: Deploy the branch build to a preview URL**

Deploy the current working tree (with Task 2–7 changes) to a Vercel **preview** pointing at the Supabase branch (`SUPABASE_URL`/keys for `<BRANCH_REF>` set as preview env, plus branch `WHEEL_TEST_TOKEN`). Run: `npx vercel deploy` (not `--prod`). Record the preview URL.

- [ ] **Step 3: Run the ramp**

```bash
node scripts/concurrency-verify.mjs --url <preview-url> --spins 500  --concurrency 100
node scripts/concurrency-verify.mjs --url <preview-url> --spins 3000 --concurrency 1000
node scripts/concurrency-verify.mjs --url <preview-url> --spins 12000 --concurrency 10000
```

Expected trend: `failed=0` at 100 and 1,000; p99 under ~2000ms at 1,000. `server_busy` may be > 0 at 10,000 (that is admission control working, not a failure). Record the numbers in the plan.

- [ ] **Step 4: Assert DB correctness (per bucket)**

For each run's `BUCKET`, run with MCP `execute_sql` (project = `<BRANCH_REF>`):

```sql
select
  (select count(*) from wheel_spin_log where test_bucket = :bucket) as rows,
  (select count(distinct spin_number) from wheel_spin_log where test_bucket = :bucket) as distinct_ordinals,
  (select count(*) from wheel_spin_log where test_bucket = :bucket and won) as wins,
  (select coalesce(sum(prize_amount),0) from wheel_spin_log where test_bucket = :bucket and won) as paid,
  (select total_wins from wheel_daily_state where test_bucket = :bucket) as state_wins,
  (select total_budget_spent from wheel_daily_state where test_bucket = :bucket) as state_budget;
```

Assert: `rows == distinct_ordinals` (no duplicate ordinals — the sequence held), `wins == state_wins`, `paid == state_budget`, `wins <= 100`, `paid <= 2000`. Any mismatch is a correctness failure — stop and fix before promoting.

- [ ] **Step 5: Commit the verifier + recorded results**

```bash
git add scripts/concurrency-verify.mjs docs/superpowers/plans/2026-07-13-spin-concurrency-scaling.md
git commit -m "test: concurrency verifier + recorded branch load-test results"
```

---

## Task 9: Promote to production

**Files:** none (deploy/migration).

- [ ] **Step 1: Apply the migrations to production**

Only after Task 8 passes: apply the Task 2 and Task 3 migrations to production project `blrrcnrhixckfudiojwe` via MCP `apply_migration` (same SQL). `ensure_daily_state` is left in place, so the currently-deployed route keeps working until the new route ships in Step 2 — no ordering break.

- [ ] **Step 2: Deploy the route to production**

```bash
npx vercel --prod --yes
```

Then confirm the deployed function region and a live test spin:

```bash
node scripts/concurrency-verify.mjs --url https://wheel-of-fortune-roan.vercel.app --spins 200 --concurrency 100
```

Expected: `failed=0`, and median latency visibly lower than the pre-change ~500ms baseline (region colocation). Clean up the test bucket afterward via `execute_sql` `delete from wheel_spin_log where test_bucket = '<bucket>'`.

- [ ] **Step 3: Bump compute for the launch window (operational)**

Before the first high-traffic 06:00 reset, raise Supabase compute for project `blrrcnrhixckfudiojwe` (Dashboard → Settings → Compute) and confirm with the user first — it is a paid change on the shared CRM instance. Right-size back down after observing real load.

- [ ] **Step 4: Delete the Supabase branch**

Once production is verified, delete branch `<BRANCH_REF>` via MCP `delete_branch` to stop branch costs.

- [ ] **Step 5: Final commit / PR**

```bash
git commit --allow-empty -m "chore: spin concurrency scaling shipped + branch torn down"
```

Open a PR from `perf/spin-concurrency-scaling` into `main` summarizing the measured before/after concurrency numbers.

---

## Self-review notes

- **Spec §4.1 (sequence)** → Task 2. **§4.2 (fold init)** → Task 2 (folded) + Task 4 (route drops ensure). **§4.3 (Telegram off path)** → Task 5. **§4.4 (region)** → Task 4 + Task 6. **§4.5 (admission control / CRM protection)** → Task 2 (`statement_timeout` → `server_busy`) + Task 7 (client retry) + Task 9 Step 3 (compute). **§6 (verify on branch, ramp, correctness)** → Task 1 + Task 8. **§7 (escalation)** → out of task scope by design; revisited only if Task 8 fails the targets.
- **Signature consistency:** `claim_spin` new arg order `(p_day, p_bucket, p_customer, p_fingerprint, p_ip, p_algorithm_id, p_winning_positions, p_skip_dedupe, p_force_prize)` is used identically in Task 2 (definition), Task 2 Step 2 (smoke test), and Task 4 Step 1 (route call).
- **Known acceptable behavior:** sequence gaps can yield slightly < 100 wins / < K2,000 on a full day; payout never exceeds K2,000. Documented in Task 2 Step 1 comments and the spec.
- **Deploy ordering:** `ensure_daily_state` intentionally not dropped, so migrations can land before the new route without breaking the live route.
