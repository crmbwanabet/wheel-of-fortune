# Wheel of Fortune — 7-Day Deposit Window + FCFS Payout Queue

**Date:** 2026-08-12
**Status:** Design (approved for planning)

## 1. Problem

Production data (last 2 weeks) shows the K2,000 daily budget is barely reached:

- ~5,500–6,000 real spins/day; only ~31% qualify under the 1-day deposit gate.
- Actual wins: 14–23/day; budget spent: K210–K620 of K2,000 (~15–20% utilisation).
- Cause is compounding waste in the position model: only ~60% of the 10,000
  winning slots are ever reached at ~6k spins/day, then ~70% of the hits belong
  to non-depositors and are voided by the gate.

Two changes, decided with the stakeholder on 2026-08-12:

1. **Widen the deposit-qualification window from 1 wheel-day to 7 wheel-days.**
2. **Replace the scattered-positions win mechanism with a first-come-first-served
   prize queue:** every qualifying spinner wins until the day's K2,000 pot is
   exhausted; after that, all spins lose until the 06:00 CAT reset.

### Decisions locked in

| Decision | Choice |
|---|---|
| Allocation | Pure first-come-first-served (no pacing, no dynamic odds) |
| Daily pot | K2,000 — unchanged |
| Prize mix | Existing 5 algorithms (K10/20/50/100/200, 100 prizes, K2,000 exact) |
| Exhausted-pot UX | Silent — indistinguishable from a normal loss; no widget change |
| Qualifying window | Deposit in the previous 7 wheel-days **or today-so-far** (up to the spin moment) |
| Rollout | Feature branch → Vercel preview → test → merge. **No push to main until preview-tested.** |

### Accepted consequences (stated to stakeholder, accepted)

- With ~55% of spins qualifying under a 7-day window, the 100 prizes are
  expected to run out around **06:45–07:00 CAT** daily; the wheel then pays
  nothing for the rest of the day, silently.
- A deposit-check timeout during the payout window now costs a guaranteed win
  rather than a ~1% chance (existing timeout rate ~3/day; gate-monitor already
  alerts on spikes).

## 2. How eligibility is known (data source)

Unchanged mechanism from the live 1-day gate (spec 2026-07-21). There is no
usable deposit database — the CRM Supabase copy is dead — so eligibility is
checked **live at spin time against the BwanaBet platform API using the
player's own session token**:

1. `embed.js` reads the non-HttpOnly `token` cookie on bwanabet.com and passes
   it to the widget → `/api/spin`.
2. The server replays the token: `POST {BWANA_API_BASE}/api/v2/transactions/history`,
   `Authorization: <raw token>` (no `Bearer`), body `{"days":"14"}`.
3. Node filters the response: any record with `op_type` starting `IN-`,
   `status === 'SUCCESS'`, `created_at` (UTC) inside the qualifying window →
   eligible.
4. 2s sync timeout, fail-closed; background completion logged to
   `wheel_deposit_checks` as today.

`days:"14"` because the API only accepts 1/3/7/14/30 and 7 wheel-days can
reach ~8 calendar days back; precise filtering stays in Node.

## 3. Part 1 — 7-day qualifying window

### `lib/wheelTime.js`

- `previousWheelDayWindowUtc(nowMs)` generalises to
  `qualifyingWindowUtc(nowMs, days)`:
  - `curStartMs` = 04:00 UTC of the current wheel-day (unchanged math).
  - `prevStartMs = curStartMs − days × 86,400,000`.
- **Window end is the spin moment, not `curStartMs`:** a deposit made today at
  09:00 qualifies a 10:00 spin immediately. Concretely the filter becomes
  `created_at ∈ [prevStartMs, nowMs]`.
- Keep a thin `previousWheelDayWindowUtc` wrapper or update call sites — either
  way existing tests are updated, not deleted.

### `lib/depositCheck.js` / `lib/depositEligibility.js`

- Request body `{"days":"3"}` → `{"days":"14"}`.
- `hasQualifyingDeposit(data, { prevStartMs, endMs })` — upper bound renamed to
  reflect "now", comparison `t >= prevStartMs && t <= endMs`.
- New env **`DEPOSIT_WINDOW_DAYS`** (default `7`), read in the spin route and
  passed down, so the window is tunable without a redeploy.

## 4. Part 2 — FCFS payout queue

### Mechanism

Replaces the 10,000-slot position map (in queue mode):

- **Day-init** (inside `claim_spin`, same advisory-lock pattern): pick 1 of the
  5 algorithms from the weighted pool as today, expand its 100 prizes,
  Fisher-Yates shuffle → store as jsonb array `prize_queue` on
  `wheel_daily_state`, with `queue_pos int` counter (0-based next index).
  The shuffle happens in Node (`lib/algorithms.js`: `generatePrizeQueue(algorithmId)`)
  and is passed to the RPC, mirroring how `winning_positions` is passed today.
- **Per spin (queue mode):**
  - `p_eligible = true` **and** `queue_pos < jsonb_array_length(prize_queue)` →
    win: prize = `prize_queue[queue_pos]`, increment `queue_pos`, update
    `total_wins` / `total_budget_spent`, map prize → segment as today.
  - Otherwise → loss segment (random of `[1,3,5,7,9]`), logged as a normal
    loss. Exhausted pot is indistinguishable from any other loss.
- Budget is exact by construction: the queue totals K2,000; no separate budget
  guard needed, no evaporation.
- **Concurrency:** the pop (read `queue_pos` → assign prize → increment) happens
  inside the same transaction/row update that already serialises counter
  updates on `wheel_daily_state`; the `UPDATE … RETURNING` pattern makes the
  claim atomic. No new race surface.

### Mode switch / rollback

- `claim_spin` gains **`p_payout_mode text DEFAULT 'positions'`**
  (`'positions'` | `'queue'`), keeping BOTH code paths.
- Route reads env **`WHEEL_PAYOUT_MODE`** (default `positions`) and passes it.
- Instant rollback = flip the env var. Prod is untouched by the migration
  itself because the default preserves current behaviour.
- In queue mode the route still sends `p_winning_positions` (ignored) or the
  queue array via a new `p_prize_queue jsonb DEFAULT NULL` param — day-init
  stores whichever the mode needs. Both are generated per-request as today
  (only the first spin of the day actually persists one).

### Migration (`supabase/migrations/2026-08-12-fcfs-payout-queue.sql`)

- `ALTER TABLE wheel_daily_state ADD COLUMN IF NOT EXISTS prize_queue jsonb,
  ADD COLUMN IF NOT EXISTS queue_pos int NOT NULL DEFAULT 0;`
- Replace `claim_spin` (single-transaction DROP+CREATE, same atomicity note as
  the 2026-07-21 migration): add `p_payout_mode`, `p_prize_queue`; preserve
  `SECURITY DEFINER`, `statement_timeout 5000ms`, `search_path`, dedupe locks,
  sequence init, logging, `p_eligible` gate, `forced_loss_ineligible`.
- Re-`GRANT EXECUTE` to `service_role`.
- **Shared-DB safety:** the new function's defaults reproduce today's prod
  behaviour exactly; prod keeps calling it in positions mode until the merged
  route passes `queue`.

### Knock-on updates

- **Telegram win message:** "position N/10000" line is meaningless in queue
  mode → becomes "win N of 100". Volume warning accepted: ~100 messages in
  ~45 min each morning (leave per-win messages as-is; muting/digest is a
  future option).
- **Daily digest (`/api/digest`):** add queue-mode stats — wins, budget spent
  (should be K2,000), and time-of-exhaustion (timestamp of the 100th win).
- **Gate-monitor:** thresholds unchanged; eligible share rising ~31%→~55% does
  not affect its fail-rate/latency/false-denial checks.
- `WINNABLE_POSITIONS` / position generation stay (positions mode still
  supported).

## 5. Rollout & preview testing

1. All work on branch `feat/fcfs-payout-queue`. **Never push to main until
   preview testing passes** (stakeholder instruction, 2026-08-12).
2. Push branch → Vercel preview deployment. Preview env sets
   `WHEEL_PAYOUT_MODE=queue`, `DEPOSIT_WINDOW_DAYS=7`.
3. Preview shares the prod Supabase DB: apply the migration (safe — defaults
   preserve prod behaviour), then test on preview **using test mode**
   (`x-wheel-test-token` + `test:true`) with a dedicated `testBucket` so
   `wheel_daily_state`/`wheel_spin_log` rows for the real day are untouched.
4. Preview test checklist:
   - Eligible spins win in queue order until 100 prizes are consumed; prize
     sum = K2,000 exactly.
   - Spin 101+ loses silently; response shape identical to a normal loss.
   - Ineligible spins always lose, even with queue remaining.
   - Concurrency burst (existing `scripts/stress-test.mjs` pattern) shows no
     double-claimed queue slot and correct final counters.
   - Positions mode still behaves exactly as prod (regression).
   - 7-day window: deposit 6 days ago qualifies; 8 days ago does not; deposit
     "today" qualifies immediately.
5. Merge to main only after the checklist passes and stakeholder confirms on
   the preview page. Flip prod `WHEEL_PAYOUT_MODE=queue` as a separate,
   reversible step.

## 6. Testing (automated)

- **Unit — `wheelTime`:** 7-day boundary (deposit at `prevStart − 1ms` vs
  `prevStart`), today-so-far inclusion, month/year rollover.
- **Unit — `depositEligibility`:** window-edge records, `IN-`/`OUT-`,
  SUCCESS/other, malformed rows — updated for `endMs` semantics.
- **Unit — `algorithms`:** `generatePrizeQueue` returns exactly 100 prizes
  summing to K2,000 for each of the 5 algorithms; shuffle preserves multiset.
- **SQL — `claim_spin` queue mode:** pop order matches stored queue; eligible
  loss after exhaustion; ineligible never pops; counters/budget correct;
  positions mode unchanged.
- **Integration — `/api/spin`:** mode plumbing (`WHEEL_PAYOUT_MODE`), test-mode
  bypass unaffected, telegram payload uses "win N of 100".

## 7. Out of scope / future

- Pacing the pot across the day (hourly slices) — explicitly rejected for v1.
- Raising the pot / adding sub-K10 faces — commercial decision.
- Muting or digesting the morning Telegram win burst.
- Pre-spin "prizes finished" messaging in the widget.
