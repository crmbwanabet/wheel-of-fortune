# Wheel of Fortune — Deposit-Eligibility Win Gate

**Date:** 2026-07-21
**Status:** Design (approved for planning)

## 1. Problem

Users create multiple BwanaBet accounts to farm wheel prizes without ever
depositing. We want to award prizes only to genuine depositors: **a spin can
only WIN if the customer made a successful deposit during the previous wheel-day.
Otherwise the spin is silently forced to a loss.** The user still spins and sees
the wheel; the outcome is just constrained to a loss segment.

## 2. Data source (investigation findings)

The shared CRM Supabase copy of deposit data is **dead** — `customers.deposit_*`
columns are empty (0 of 90,964 rows populated), last import ~a month ago, no
per-day granularity. It cannot be used.

The authoritative, live source is the **BwanaBet platform API** (EnerGaming
white-label). Verified working, server-to-server, with no dev-team dependency:

- **Endpoint:** `POST https://api.bwanabet.co.zm/api/v2/transactions/history`
- **Body:** `{"days":"<N>"}` (N ∈ 1/3/7/14/30)
- **Auth:** the raw session JWT in an `Authorization` header **with NO `Bearer`
  prefix**. `Authorization: <token>` returns data; `Authorization: Bearer <token>`
  returns empty. (Verified 2026-07-21 via server-side `curl`, HTTP 200.)
- **The wheel already receives this exact token** — `embed.js` reads it from the
  non-HttpOnly `token` cookie and hands it to the widget, which sends it to
  `/api/spin`. So the wheel replays a token it already holds.
- **Response shape:**
  ```json
  {"error":false,"message":"Success","data":[
    {"id":8804935,"amount":"5.00","currency":"K",
     "created_at":"2026-07-03T13:09:36.000Z","updated_at":"...",
     "op_type":"OUT-KZ-AIRTEL","status":"SUCCESS","token":"..."}]}
  ```
  - `op_type` prefix = direction+provider: **`IN-*` = deposit**, `OUT-*` = withdrawal.
  - `status` = `SUCCESS` / other.
  - `created_at` = **UTC** ISO timestamp.
- **Latency:** ~0.3–0.4s per call, stable across `days` values.

### Token validation is free

A forged or expired token gets no valid response from the API → no qualifying
deposit → the user is treated as ineligible → loss. So the deposit call doubles
as authentication; we do **not** need to enable JWT signature verification for
this feature.

## 3. Timezone (verified 2026-07-21)

- Zambia = **CAT = UTC+2, no DST**. (The dev sandbox's tzdata mislabels
  `Africa/Lusaka` as UTC+0 — do **not** trust local `Date`/`TZ` on the server.)
- API `created_at` is **UTC** (`Z`). Proof: a record with `created_at`
  `2026-07-03T13:09:36Z` rendered in BwanaBet's own UI as `03/07 | 15:09`
  (= +2h = CAT).
- The wheel day already resets at **06:00 CAT = 04:00 UTC** (`getWheelDayDate`,
  `embed.js`, `WheelWidget.jsx`).
- **All window math is done in UTC.** Never compare against server-local time.

### "Deposited the day before" window

For a spin on wheel-day `D` (which starts at `D 04:00 UTC`), a qualifying
deposit is a record with:

- `op_type` starting with `IN-`, **and**
- `status === 'SUCCESS'`, **and**
- `created_at ∈ [ (D-1) 04:00 UTC , D 04:00 UTC )` — i.e. the entire previous
  wheel-day.

Helper: `wheelDayStartUtc(dateStr) = Date.parse(dateStr + 'T04:00:00Z')`;
`curStart = wheelDayStartUtc(getWheelDayDate())`; `prevStart = curStart - 86400000`.

We query the API with `days:"3"` (margin against the API's own day-bucketing) and
filter precisely by `created_at` in Node.

> **To confirm during implementation:** the exact `IN-*` prefix, against a real
> deposit record (the test account only had an `OUT-` withdrawal). Assumption:
> `op_type.startsWith('IN')`.

## 4. Architecture

The check is **live at spin time** — a batch/cron is impossible because the only
moment we hold a user's token is when their browser presents it. Latency is
hidden behind the wheel's **≥5s brake/decel animation** (`WheelWidget.jsx`
`Math.max(5000, …)`), so there is no user-perceived delay.

### Flow in `/api/spin`

```
1. (existing) resolve identity: real traffic → verifyBwanaToken(token).id
2. deposit check (lib/depositCheck.js):
     - start fetch to history API, Authorization:<raw token>, body {"days":"3"}
     - race the fetch against a 2s timer (DEPOSIT_CHECK_TIMEOUT_MS)
     - sync result = { eligible, reason, latencyMs }
         reason ∈ deposit_found | no_deposit | timeout | error
       fail-closed: timeout/error ⇒ eligible=false
     - DO NOT abort the fetch on timeout — keep its promise for the background
3. claim_spin(..., p_eligible = <effective eligibility>) → spin result
4. return spin response to widget  (animation is still running)
5. waitUntil():
     - await the SAME fetch to completion (hard cap ~10s)
     - compute eventual { eligible, reason, latencyMs }
     - INSERT one wheel_deposit_checks row with BOTH sync + eventual fields
```

### Rollout modes — `DEPOSIT_GATE_MODE` env

Instrumentation-first, matching the "track it, then trust it" posture:

- **`off`** — no check, no gate (instant kill-switch; behaves like today).
- **`shadow`** — run the check and **log** to `wheel_deposit_checks`, but always
  pass `p_eligible = true` to `claim_spin`. Outcomes are unaffected; we gather
  real reliability/latency data with zero risk to players.
- **`enforce`** — run the check, log, and pass the **real** eligibility, forcing
  losses for ineligible users.

Plan: ship in `shadow`, watch the data, flip to `enforce` once the false-denial
rate and latency are acceptable. `off` is the emergency stop.

## 5. Components

### 5.1 `lib/wheelTime.js` (new, or extend `lib/algorithms.js`)
- `wheelDayStartUtc(dateStr) → epochMs`
- `previousWheelDayWindow(now) → { prevStartMs, curStartMs }`
- Pure functions, fully unit-tested around the 04:00 UTC boundary.

### 5.2 `lib/depositCheck.js` (new)
- `checkDepositEligibility({ token, now, timeoutMs, apiBase }) → { sync, completion }`
  - `sync` resolves within `timeoutMs`: `{ eligible, reason, latencyMs }`.
  - `completion` is a Promise for the eventual `{ eligible, reason, latencyMs,
    httpStatus, error }` (awaited in `waitUntil`, hard-capped).
  - Parsing: `data[]` → any record with `op_type.startsWith('IN')` &&
    `status==='SUCCESS'` && `created_at ∈ [prevStart, curStart)`.
  - Never throws to the caller; all errors map to `reason:'error', eligible:false`.

### 5.3 `app/api/spin/route.js`
- After identity resolution, before `claim_spin`, run the check (only for real
  traffic; see §7).
- Compute effective eligibility from mode: `shadow`/`off` ⇒ `true`,
  `enforce` ⇒ `sync.eligible`.
- Pass `p_eligible` to the `claim_spin` RPC call.
- `waitUntil` the `completion` promise → insert the tracking row (§6).
- Reuse existing `reportError` for hard failures.

### 5.4 Supabase migration (new file under `supabase/migrations/`)
- **Replace `claim_spin`**: drop the existing 7-arg legacy and 9-arg overloads,
  create a single new function that adds **`p_eligible boolean DEFAULT true`**.
  Preserve `SECURITY DEFINER`, `statement_timeout '5000ms'`,
  `search_path public,pg_temp`, the per-day sequence init, dedupe locks, and
  logging. New logic, placed after the win/force-prize decision:
  ```plpgsql
  -- Ineligible depositors cannot win: convert a would-be win into a loss.
  IF v_is_win AND NOT p_eligible THEN
    v_is_win := false;
    v_prize  := NULL;
  END IF;
  ```
  (This runs before segment mapping / counter updates, so win counters and
  budget are untouched and the spin is logged as a loss.)
- Add `'forced_loss_ineligible'` to the returned JSON so the API can telemeter.
- **New table `wheel_deposit_checks`** (see §6) + index + `service_role` grants.
- Re-`GRANT EXECUTE` on the new `claim_spin` to `service_role`.

### 5.5 Daily digest (`app/api/digest/route.js`) — optional add
- Roll up yesterday's `wheel_deposit_checks`: total checks, API success rate,
  p50/p95 latency, `forced_loss` count, and **false-denial rate** = fraction of
  `forced_loss` rows with `eventual_eligible = true`.

## 6. Tracking table

```sql
CREATE TABLE wheel_deposit_checks (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  day_date           date        NOT NULL,
  customer_id        text        NOT NULL,
  mode               text        NOT NULL,          -- shadow | enforce
  decision           text        NOT NULL,          -- the check's sync VERDICT (what enforce would do): eligible | forced_loss
  enforced           boolean     NOT NULL,          -- true only in enforce mode; in shadow the verdict was advisory
  reason             text        NOT NULL,          -- deposit_found|no_deposit|timeout|error
  sync_latency_ms    int,
  eventual_eligible  boolean,                        -- null if bg never returned
  eventual_reason    text,                           -- deposit_found|no_deposit|error|bg_timeout
  eventual_latency_ms int,
  http_status        int,
  error_text         text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wheel_deposit_checks_day_idx ON wheel_deposit_checks (day_date);
```

- One row per real spin that ran a check. Inserted from `waitUntil` (off the hot
  path). Low volume (≤ one per customer per day) — nowhere near the load-incident
  envelope; and it targets the wheel's own table, not CRM tables.
- `decision` is always the check's sync verdict (what `enforce` would do), so
  shadow-mode rows measure real impact; `enforced` says whether it actually
  affected the spin.
- `sync_*` = what drove the verdict; `eventual_*` = ground truth once the call
  finished (answers "was a timed-out user actually eligible?").

### Key metrics this enables
- **Is the tool working?** API success rate, p50/p95 `eventual_latency_ms`.
- **Cost of fail-closed?** false-denial rate = `forced_loss ∧ eventual_eligible`.
- **Can we relax the timeout / trust late calls?** Decide from the latency
  distribution + false-denial rate.

## 7. Test mode, config, failure handling

- **Test/load traffic** (`isTest`) has no real token → **skip the API call**;
  eligibility driven by a body flag (default eligible=true) so existing load
  tests and `forceWin` paths are unaffected and never hit BwanaBet.
- **Env / config:**
  - `DEPOSIT_GATE_MODE` = `off` | `shadow` | `enforce` (default `off`).
  - `DEPOSIT_CHECK_TIMEOUT_MS` (default `2000`).
  - `DEPOSIT_CHECK_BG_CAP_MS` (default `10000`) — hard cap for the background await.
  - `BWANA_API_BASE` (default `https://api.bwanabet.co.zm`).
- **Fail-closed** on timeout/error/non-200/`error:true` in `enforce`.
- The deposit check must **never break a spin**: any unexpected error →
  `reason:'error'`, eligible=false (enforce) / logged (shadow), spin proceeds.
- `already_spun` retries may waste a check (rare); acceptable.

## 8. Testing

- **Unit — `wheelTime`:** window boundaries around 04:00 UTC (deposit at 03:59
  UTC vs 04:00 UTC; day rollover; month/year rollover).
- **Unit — `depositCheck` parsing:** `IN-` SUCCESS in window ⇒ eligible;
  `OUT-` ⇒ not; `IN-` PENDING ⇒ not; `IN-` outside window ⇒ not; empty data ⇒ not.
- **Unit — timeout/error mapping:** mocked fetch → timely-eligible,
  timely-ineligible, slow (>timeout), network error, non-200, `error:true` →
  correct `sync` + `completion`.
- **SQL — `claim_spin`:** `p_eligible=false` + winning `spin_number` ⇒ logged
  loss, `total_wins`/budget unchanged, `forced_loss_ineligible=true`;
  `p_eligible=true` unchanged from today.
- **Integration — `/api/spin`:** shadow mode never changes outcome but logs;
  enforce mode forces loss on ineligible; test mode skips the call.

## 9. Out of scope / future

- Compensating users wrongly denied during an outage (tracking only, for now).
- Moving to a JWT deposit claim if BwanaBet later adds one (would remove the
  per-spin API call).
- Caching / pre-warming if latency proves problematic.
- Configurable qualifying window (e.g. "last 24h" vs "prior wheel-day") — fixed
  to prior wheel-day for v1.
```
