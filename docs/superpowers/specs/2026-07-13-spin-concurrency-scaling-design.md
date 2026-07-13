# Wheel of Fortune — Spin Concurrency Scaling Design

**Date:** 2026-07-13
**Repo:** `crmbwanabet/wheel-of-fortune`
**Database:** Supabase Pro, Postgres 17, project `blrrcnrhixckfudiojwe` (region `eu-west-1`)
**Deployed at:** `https://wheel-of-fortune-roan.vercel.app`

---

## 1. Goal

The spin endpoint must sustain **1,000 concurrent spin requests** without correctness failures or client timeouts, and **10,000 concurrent** as a stretch target. The player base is 200,000+, so a daily 06:00 CAT reset — especially if announced by a push/notification blast — can produce a large simultaneous burst.

Explicit non-goals: introducing Redis or an async queue *at this stage*. We optimize within the existing Supabase + Vercel stack first, measure, and only escalate if the target is genuinely unreachable.

## 2. Current behavior (must be preserved)

- Each day (keyed `day_date` + `test_bucket`) has a `winning_positions` JSONB map: exactly **100 winning spin-ordinals** drawn from `1..10000`, whose prizes sum to exactly **K2,000** (one of 5 preset algorithms).
- A spin is the *N*th of the day; if *N* is a key in the map it wins that prize, else it loses. Ordinals past 10,000 always lose.
- Guarantees on a full day (≥10,000 completed spins): exactly 100 winners, exactly K2,000 paid. On lighter days the payout is proportionally lower — **K2,000 is a ceiling, not a floor**.
- Once-per-day per customer (and per device fingerprint) is enforced in `claim_spin`.

**These guarantees are retained unchanged.** A verified full-day simulation (10,000 spins @ concurrency 40) confirmed the DB stays internally consistent (contiguous unique ordinals, counters match the log, payout ≤ K2,000) even when clients time out.

## 3. The bottleneck

`claim_spin` assigns each spin its ordinal with:

```sql
UPDATE wheel_daily_state
SET total_spins = total_spins + 1
WHERE day_date = p_day AND test_bucket = p_bucket
RETURNING total_spins ...
```

Every spin of the day — winners and the ~99% who lose — takes a **row lock on the single daily-state row**. Postgres serializes all concurrent spins behind that one lock. Measured effect at concurrency 40: throughput plateaued ~75 rps, p99 ≈ 4.8 s, worst case ≈ 128 s (client timeouts). This single row is the hard ceiling; nothing else in the path is the limiter at these volumes.

Secondary costs on the hot path:
- `ensure_daily_state` runs an upsert round-trip on **every** spin (only the first of the day does any work).
- The Telegram win notification is **awaited** inside the request (wins only, ~100/day).
- Likely cross-region latency: DB is in `eu-west-1`; if the spin function runs elsewhere every query pays a round trip (a plausible chunk of the ~500 ms median).

## 4. Design

### 4.1 Replace the counter row with a per-day Postgres sequence

Ordinals come from a **sequence**, not a row `UPDATE`. `nextval()` is engineered for high-concurrency, lock-free-in-practice increments: concurrent callers get unique increasing values without waiting on each other.

- One sequence per active `(day_date, test_bucket)`, named deterministically, e.g. `wheel_seq_<bucket_or_main>_<yyyymmdd>`. For production the bucket is `''` so exactly one sequence is active per day.
- `ensure_daily_state` (now folded — see 4.2) creates the sequence idempotently (`CREATE SEQUENCE IF NOT EXISTS`).
- `claim_spin` obtains its ordinal via `nextval(<seq>)` instead of the `UPDATE ... RETURNING`.
- **Gaps are acceptable.** A failed/rolled-back spin still consumes a sequence value, so a winning ordinal can occasionally go unclaimed → at most a few fewer winners and a payout slightly under K2,000. This never exceeds the budget and mirrors today's under-full-day behavior. Documented, not a defect.
- `total_wins` / `total_budget_spent` on `wheel_daily_state` are updated **on wins only** (~100/day, negligible contention) for reporting. `total_spins` is no longer maintained per spin — the current spin count is read from the sequence (`last_value`) when needed. The Telegram "X/100 wins, KY/K2000" line reads `total_wins` / `total_budget_spent`.

**Winner check is unchanged:** ordinal → lookup in `winning_positions`. Exact-100 / exact-K2000 semantics preserved.

Sequence cleanup: a daily job (or lazy drop inside day-init) drops sequences older than a few days so they don't accumulate.

### 4.2 Do daily setup once, not per spin

Fold day initialization into a single RPC so a spin is **one** DB round trip, not two:

- `claim_spin` begins with `INSERT INTO wheel_daily_state ... ON CONFLICT DO NOTHING` and `CREATE SEQUENCE IF NOT EXISTS` (both no-ops after the first spin of the day).
- The separate `ensure_daily_state` call in `app/api/spin/route.js` is removed; the route passes the JS-generated algorithm id + winning map into `claim_spin`, where the `ON CONFLICT DO NOTHING` insert consumes them only on the first spin of the day and ignores them thereafter. Map generation stays in JS (in-memory, cheap); what's removed is the **extra DB round trip** per spin, not the map computation. Net: one DB round trip per spin instead of two.

### 4.3 Move the Telegram notification off the response path

Return the spin result immediately; send the Telegram alert after the response using Vercel's post-response execution (`waitUntil`) rather than `await`. Wins only; removes ~200 ms from the ~100 winning requests and decouples spin latency from Telegram availability.

### 4.4 Region colocation

Pin the spin function to the Vercel region nearest Supabase `eu-west-1` (e.g. `fra1` or `dub1`) via route config (`preferredRegion`) and align the Vercel project region. Removes cross-Atlantic round trips from every query. Verify actual placement after deploy (measure median latency drop).

### 4.5 Protect the shared CRM database

Because this Postgres instance also serves the **live CRM**, a spin surge must not exhaust connections/CPU and starve CRM queries:

- **Admission control:** cap in-flight spin work so excess load is shed with a fast, friendly `429` ("try again in a moment") instead of queuing on the DB. The existing IP rate limiter is the seam; add a global/day concurrency ceiling tuned from load-test numbers.
- **Connection strategy:** the hot path uses supabase-js (PostgREST/HTTP), which pools server-side; confirm PostgREST throughput headroom and, if direct connections are ever used, route them through the Supavisor pooler (transaction mode).
- **Compute:** bump Supabase compute for the launch window; revert or right-size afterward. This benefits the CRM during the burst too.
- **Client retry safety:** a timed-out spin is safe to retry — dedupe returns `already_spun` if the first claim committed, or a fresh spin if it did not. The widget should retry once on network error/timeout before showing an error.

## 5. Affected components

| Component | Change |
|-----------|--------|
| `claim_spin` (Postgres RPC) | Ordinal via `nextval` (not row `UPDATE`); fold day-init + `CREATE SEQUENCE IF NOT EXISTS`; update reporting counters on wins only |
| `ensure_daily_state` (RPC) | Absorbed into `claim_spin`; standalone call removed |
| new: day sequences + cleanup | `wheel_seq_<bucket>_<day>` created on first touch; periodic drop of stale sequences |
| `app/api/spin/route.js` | Drop separate ensure call; `waitUntil` for Telegram; `preferredRegion`; retry-safe contract |
| `lib/telegram.js` | Invoked post-response (fire-after) rather than awaited |
| `lib/rateLimit.js` / route | Add global concurrency ceiling (admission control) |
| Vercel/Supabase config | Region alignment; launch-window compute bump |

## 6. Verification

Load-test on a **Supabase branch** (Pro feature) so the live CRM is never touched. Reuse/extend `scripts/full-day-simulation.mjs` and `scripts/stress-test.mjs` pointed at the branch, ramping concurrency **100 → 1,000 → 10,000**.

Per run, assert:
- **Correctness (DB ground truth):** ordinals unique (`count(distinct spin_number) = count(*)`), wins only from the map, `total_wins ≤ 100`, `total_budget_spent ≤ 2000`, counters match the log.
- **Throughput/latency:** sustained rps; p50/p95/p99; error/timeout rate.
- **DB health:** CPU, connections, lock waits during the burst.

**Success:** 1,000 concurrent with p99 < ~2 s and zero correctness violations. **Stretch:** 10,000 concurrent sustained (tells us if the compute bump suffices or if Redis/queue is eventually needed). Record the measured ceiling either way — no silent assumptions.

## 7. Escalation path (only if targets unmet)

1. Larger Supabase compute (measure headroom first).
2. Move the wheel's hot counter off the shared instance (dedicated resources).
3. Redis atomic counter (Upstash) in front — the original Approach for 10k+ if Postgres can't reach it.
4. Async accept + background resolve (changes UX; last resort).

## 8. Out of scope

- Redis / queue (escalation only).
- The probabilistic "~100 winners" payout model (explicitly rejected; exact-100/K2000 retained).
- Win-selection algorithm, prize mix, daily budget amount, dedupe rules, security/RLS work (separate branch).
- Widening the 10,000-position map for very high-volume days (product question, not throughput).
