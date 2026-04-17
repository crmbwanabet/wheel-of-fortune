# Wheel of Fortune — Atomic RPC Rewrite & Stress Test

**Date:** 2026-04-17
**Repo:** `crmbwanabet/wheel-of-fortune`
**Supabase project:** `blrrcnrhixckfudiojwe`
**Deployed at:** `https://wheel-of-fortune-roan.vercel.app`

---

## 1. Why

The current `/api/spin` has three problems that compound under load:

1. **Security hole.** The public endpoint accepts `test:true` and `forceWin` in the request body, letting any caller bypass dedupe and trigger a Telegram "win" notification without a real spin.
2. **Non-atomic state.** Per spin: customer-dedupe query → fingerprint-dedupe query → daily-state fetch (+ init race) → optimistic-lock counter update (with single retry) → conditional win-counter update → spin-log insert. 4–6 roundtrips, three places a partial failure can drift the budget.
3. **Contention.** Optimistic-lock with one retry starves under real concurrency — the existing stress test already has a branch for "server_busy = atomic counter contention (expected)." That's a workaround, not correctness.

The fix is a two-RPC design that moves the hot path into one Postgres transaction.

## 2. Scope

**In scope**
- Two new Postgres RPCs: `ensure_daily_state`, `claim_spin`
- Rewrite `app/api/spin/route.js` to orchestrate the RPCs
- Close the `test:true` / `forceWin` hole with an `x-wheel-test-token` header
- Upgrade `scripts/stress-test.mjs` to use the token; add a new atomic-counter contention test; rerun against prod

**Out of scope**
- Replacing in-memory rate limiter (tracked separately)
- `WheelWidget.jsx` client changes (contract unchanged)
- `app/api/validate/route.js`
- Schema changes beyond adding `is_test boolean` column to `wheel_spin_log`

## 3. Architecture

### RPC 1: `ensure_daily_state(p_day date, p_bucket text, p_algorithm_id int, p_winning_positions jsonb) → void`

Idempotent. `INSERT INTO wheel_daily_state (day_date, test_bucket, algorithm_id, winning_positions, ...) VALUES (...) ON CONFLICT (day_date, test_bucket) DO NOTHING`. Safe to call on every spin; only the first call per (day, bucket) writes.

Rationale for putting init on every call: eliminates the "is this the first spin today?" branch in JS, and makes the first spin of a day 1 extra write (not a race).

### RPC 2: `claim_spin(p_day date, p_customer text, p_fingerprint text, p_ip text, p_bucket text default '', p_skip_dedupe boolean default false, p_force_prize int default null) → jsonb`

Test isolation: a new `test_bucket text NOT NULL DEFAULT ''` column on both `wheel_daily_state` and `wheel_spin_log`. Prod rows use `test_bucket=''`. Test traffic uses a non-empty bucket (e.g. `'stress-<runId>'`) so test counters and winning-position consumption are fully isolated from prod, without changing `day_date` type. Unique constraints become `(day_date, test_bucket)`. No data migration needed — existing prod rows default to `''`.

Runs inside a single transaction:

1. **Dedupe** (unless `p_skip_dedupe`):
   `SELECT 1 FROM wheel_spin_log WHERE day_date = p_day AND test_bucket = p_bucket AND (customer_id = p_customer OR fingerprint = p_fingerprint) LIMIT 1`
   → if hit, return `jsonb_build_object('error', 'already_spun')`.

2. **Atomic increment** via row-locking `UPDATE`:
   `UPDATE wheel_daily_state SET total_spins = total_spins + 1 WHERE day_date = p_day AND test_bucket = p_bucket RETURNING total_spins, winning_positions, total_wins, total_budget_spent INTO v_spin_number, v_map, v_wins, v_budget`
   → if no row, return `{error: 'no_state'}` (shouldn't happen after `ensure`).

3. **Win lookup**:
   `v_prize := COALESCE(p_force_prize, (v_map ->> v_spin_number::text)::int)`
   `v_is_win := v_prize IS NOT NULL`

4. **Segment mapping** (in-function LUT):
   - Win: `v_segment := CASE v_prize WHEN 10 THEN 0 WHEN 50 THEN 2 WHEN 200 THEN 4 WHEN 20 THEN 6 WHEN 100 THEN 8 END`
   - Loss: `v_segment := (ARRAY[1,3,5,7,9])[1 + floor(random() * 5)::int]`

5. **If win**, update counters in same txn:
   `UPDATE wheel_daily_state SET total_wins = total_wins + 1, total_budget_spent = total_budget_spent + v_prize WHERE day_date = p_day AND test_bucket = p_bucket`

6. **Log**:
   `INSERT INTO wheel_spin_log (day_date, test_bucket, customer_id, spin_number, won, prize_amount, segment_index, fingerprint, ip_address) VALUES (...)`

7. **Return**:
   ```json
   { "win": bool, "segment_index": int, "prize_amount": int | null,
     "spin_number": int, "wins_today": int, "budget_today": int }
   ```

Counters are returned so the API can forward them to Telegram without a re-read.

### Orchestrator: `app/api/spin/route.js`

```
POST /api/spin { customerId, fingerprint }
  ├─ rate-limit check (unchanged in-memory, per-IP 5/min)
  ├─ validate customerId is a non-empty string
  ├─ parse x-wheel-test-token header
  │    └─ if matches process.env.WHEEL_TEST_TOKEN:
  │         read optional test:true and forceWin:<amount> from body
  │         otherwise ignore those body fields entirely
  ├─ dayDate  = getWheelDayDate()                // lib/algorithms.js (unchanged)
  ├─ bucket   = isTest ? (req.body.testBucket || 'stress') : ''
  ├─ algoId   = pickAlgorithm()                  // lib/algorithms.js (unchanged)
  ├─ map      = buildWinningMap(algoId)          // lib/algorithms.js (unchanged)
  ├─ supabase.rpc('ensure_daily_state', {p_day: dayDate, p_bucket: bucket,
  │                                      p_algorithm_id: algoId, p_winning_positions: map})
  ├─ result = supabase.rpc('claim_spin', {p_day: dayDate, p_bucket: bucket,
  │                                       p_customer: cleanId, p_fingerprint: fp, p_ip: ip,
  │                                       p_skip_dedupe: isTest, p_force_prize: forceWin || null})
  ├─ if result.win → sendWinNotification({...}, fire-and-forget)
  └─ return { win, segmentIndex, prize: isWin ? { kwacha: prize_amount } : null }
```

Hot-path DB cost: **2 RPC calls** (`ensure` + `claim`). Every subsequent call today: `ensure` is a no-op conflict, `claim` is one transaction.

## 4. Files

**New**
- `supabase/migrations/2026-04-17-wheel-rpc.sql` — schema changes + two RPCs:
  - `ALTER TABLE wheel_daily_state ADD COLUMN test_bucket text NOT NULL DEFAULT ''`
  - `ALTER TABLE wheel_spin_log ADD COLUMN test_bucket text NOT NULL DEFAULT ''`
  - Drop old unique constraint on `wheel_daily_state(day_date)`, add unique `(day_date, test_bucket)`
  - Add unique `(day_date, test_bucket, customer_id)` and `(day_date, test_bucket, fingerprint) WHERE fingerprint IS NOT NULL` on `wheel_spin_log` (backs the dedupe query)
  - `CREATE FUNCTION ensure_daily_state(...)`, `CREATE FUNCTION claim_spin(...)`
- `docs/superpowers/specs/2026-04-17-wheel-rpc-rewrite-design.md` — this doc

**Modified**
- `app/api/spin/route.js` — stripped to orchestration only; no dedupe queries, no optimistic-lock retry, no unprotected `test`/`forceWin`
- `scripts/stress-test.mjs` — read `WHEEL_TEST_TOKEN` env, send as `x-wheel-test-token`; add Test 6 (atomic-counter contention); tighten Test 3 assertions
- `.env.example` — add `WHEEL_TEST_TOKEN=<generate-with-openssl-rand-hex-32>`
- Vercel env + local `.env.local` — add `WHEEL_TEST_TOKEN`

**Unchanged**
- `components/WheelWidget.jsx`, `lib/algorithms.js`, `lib/fingerprint.js`, `lib/supabase.js`, `lib/rateLimit.js`, `lib/telegram.js`, `app/api/validate/route.js`
- Table schemas for `wheel_daily_state` and `wheel_spin_log` (only adding one column)

## 5. Error Handling

| Scenario | Source | Response | HTTP |
|---|---|---|---|
| Rate limited | API | `{error:'rate_limited'}` | 429 |
| Invalid JSON body | API | `{error:'invalid_body'}` | 400 |
| Missing customerId | API | `{error:'missing_customer_id'}` | 400 |
| Customer or fingerprint already spun today | RPC | `{error:'already_spun'}` | 200 |
| Daily state row missing after ensure | RPC | `{error:'no_state'}` → `server_error` | 500 |
| SQL exception in RPC | caught | `{error:'server_error'}` | 500 |
| Telegram down | caught | swallowed, logged | spin still 200 |

Test-mode with missing/wrong `x-wheel-test-token`: treated as normal traffic (no 401, no hint that test mode exists — probing returns identical responses).

## 6. Concurrency Guarantees

| Scenario | Guarantee | Mechanism |
|---|---|---|
| Two callers race on day init | Exactly one row written | `ON CONFLICT (day_date) DO NOTHING` |
| N concurrent `claim_spin` | Each gets unique `spin_number`, no `server_busy` | Postgres row lock acquired by `UPDATE ... RETURNING` |
| Spin succeeds but log insert fails | All counters roll back | Single transaction |
| Customer + fingerprint hit different rows | First match returned | `OR` with `LIMIT 1` |
| Clock skew at 6am CAT | Accepted risk: two days may init in a small window | JS computes `dayDate` before RPC |

## 7. Stress Test Upgrades

`scripts/stress-test.mjs` changes:

1. **Auth**: `const TOKEN = process.env.WHEEL_TEST_TOKEN`; fail fast with a clear error if missing. All `spin()` calls send `x-wheel-test-token: TOKEN` and body `{test: true, testBucket: 'stress-<runId>'}`. Each run uses a unique bucket so consecutive runs don't collide on dedupe or exhaust the winning-position map.
2. **Existing Test 3 (rate limiting)**: with the test token, rate limits still apply per IP, so the assertion `rateLimited.length > 0` can be made firm (remove the "cold start may have reset" softness).
3. **New Test 6 — atomic counter contention**:
   - Fire 20 concurrent `claim_spin`s with unique customer IDs against a single day with `--no-ratelimit`
   - Assert: `successes === 20`, `total_spins` after = 20, every returned `spin_number` is unique and in `[1..20]`, zero `server_busy` errors
   - This is the test that would have caught the old optimistic-lock starvation
4. **Latency targets** to report against (not hard-fail): p50 < 200ms, p95 < 500ms, p99 < 1000ms against Vercel prod

Run plan: deploy migration → deploy code → run `node scripts/stress-test.mjs --spins 100` → report latency histogram, error distribution, win-rate sanity check (≈1% over enough spins).

## 8. Rollout

1. Apply migration in Supabase SQL editor (manual paste of `2026-04-17-wheel-rpc.sql`)
2. Set `WHEEL_TEST_TOKEN` in Vercel env (production + preview)
3. Deploy code to Vercel
4. Run stress test against prod
5. Monitor `wheel_spin_log` for 24h — check `is_test` separation, watch for unexpected `already_spun` rates

**Rollback**: revert the deploy; the new RPCs and `is_test` column are additive and can stay.

## 9. Open Questions

None blocking. Noted for later:
- Replace in-memory rate limiter with Supabase-backed counter (survives cold starts)
- Add `wheel_spin_log(day_date, customer_id)` and `wheel_spin_log(day_date, fingerprint)` indexes if dedupe query shows up in Supabase slow-query log after launch
