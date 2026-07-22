# Wheel of Fortune — Deposit-Gate Alerting Design

**Date:** 2026-07-22
**Repo:** `crmbwanabet/wheel-of-fortune`
**Deployed at:** `https://wheel-of-fortune-roan.vercel.app`

---

## 1. Goal

Proactively alert the owner's Telegram DM when the deposit-eligibility gate is
unhealthy, so problems are caught **before** they quietly cost players prizes —
especially once `DEPOSIT_GATE_MODE=enforce`, where a silent BwanaBet API outage
means every spin is fail-closed to a loss with no visible symptom.

Alert on four situations (all owner-selected):
1. **API failing/degraded** — sustained `error`/`timeout` results from the deposit check.
2. **Latency spikes** — `eventual_latency_ms` p95 creeping toward the 2s sync timeout.
3. **False-denials** — spins the gate ruled `forced_loss` whose eventual ground-truth was `eligible=true` (real depositors denied by a timeout/error).
4. **Enforce-mode outage guard** — a louder, stricter alert when #1 happens while in `enforce` (players actively losing earned prizes).

Non-goals: dashboards, per-spin alerts, third-party observability, any change to
spin/gate/payout logic.

## 2. Context & dependencies

- The gate logs one row per real spin to **`wheel_deposit_checks`** (durable):
  `mode, decision(eligible|forced_loss), enforced, reason(deposit_found|no_deposit|timeout|error), sync_latency_ms, eventual_eligible, eventual_reason, eventual_latency_ms, http_status, error_text, created_at, customer_id, day_date`.
- **Why read the table, not the live `reportError` path:** the existing telemetry
  state (`lib/telemetry.js`) is per-serverless-instance in-memory, so rate/health
  signals fragment across instances (telemetry gap #1). Reading the durable table
  on a schedule sidesteps that entirely and needs no KV dependency.
- **Depends on the `errCode 28 → no_deposit` fix (PR #2, shipped).** That fix is
  what makes `reason='error'` a clean "API is actually broken" signal instead of
  being polluted by the common empty-history case.

## 3. Architecture

### 3.1 Endpoint — `app/api/gate-monitor/route.js` (new)
- `CRON_SECRET`-gated (Bearer), GET/POST, `dynamic = 'force-dynamic'` — same shape as `/api/digest`.
- **Reads only** from `wheel_deposit_checks`; the sole write is one tiny upsert to `wheel_monitor_state` (§3.4). Never in the spin path.
- Whole handler in `try/catch`. If its own query throws, it calls
  `reportError(err, { route: 'gate-monitor', status: 500, code: 'monitor_query_failed' })`
  (so a broken monitor is itself visible) and returns `200`.

### 3.2 Schedule — `vercel.json`
- Add cron `{ "path": "/api/gate-monitor", "schedule": "*/10 * * * *" }` (every 10 min).

### 3.3 Evaluation — pure functions in `lib/gateHealth.js` (new)

`evaluateGateHealth(rows, thresholds)` → `{ n, failureRate, p95LatencyMs, falseDenials, hasEnforce, enforceFailureRate, conditions }` where `conditions` is a map of `{ api_failing, latency, false_denials } → { firing: boolean, detail: string }`.

Metrics over the lookback window (`rows` = `wheel_deposit_checks` where `created_at >= now - WINDOW_MIN`):
- `n` = row count.
- `failureRate` = `count(reason IN ('error','timeout')) / n`.
- `p95LatencyMs` = 95th percentile of `eventual_latency_ms` over rows where it is non-null.
- `falseDenials` = `count(decision='forced_loss' AND eventual_eligible = true)`.
- `hasEnforce` = any row with `mode='enforce'`; `enforceFailureRate` = failure rate over the `enforce` subset.

Condition logic (thresholds from §5, all env-tunable):
- **`api_failing`** — mode-aware (covers owner items #1 and #4). If `hasEnforce`: fires when `enforceFailureRate ≥ FAIL_RATE_ENFORCE (0.20)` and enforce-subset `n ≥ MIN_SAMPLE`; severity = **critical**, message names enforce impact + recommends `DEPOSIT_GATE_MODE=off`. Else (shadow): fires when `failureRate ≥ FAIL_RATE_SHADOW (0.30)` and `n ≥ MIN_SAMPLE`; severity = **warning**. (Because `DEPOSIT_GATE_MODE` is a single global env var, a window is effectively all-shadow or all-enforce; a brief mixed window after a deploy flip is harmless.)
- **`latency`** — fires when `p95LatencyMs ≥ P95_MS (1500)` and `n ≥ MIN_SAMPLE`.
- **`false_denials`** — fires when `falseDenials ≥ FALSE_DENIALS (3)`.

`MIN_SAMPLE` gating prevents noise from a couple of one-off errors in a quiet window.

### 3.4 State & anti-spam — `wheel_monitor_state` (new table) + `decideAlerts`

Pure `decideAlerts(evaluation, priorStateByCondition, now, cooldownMs)` → list of `{ condition, action: 'fire'|'recover', severity, text }`.
- For each condition: breached & (not previously firing **or** `now - last_alert_at ≥ COOLDOWN`) → `fire` (send alert, set `firing=true, last_alert_at=now`). Not breached & was firing → `recover` (send "recovered ✅", set `firing=false`). Otherwise no-op.
- Cooldown (default 30 min) means a persistent problem re-pings occasionally, not every 10 min.

Table:
```sql
CREATE TABLE wheel_monitor_state (
  condition     text PRIMARY KEY,          -- api_failing | latency | false_denials
  firing        boolean NOT NULL DEFAULT false,
  last_alert_at timestamptz,
  last_value    text,                      -- human snapshot, e.g. "failRate=0.42 n=57"
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```
RLS enabled, `REVOKE` anon/authenticated, `GRANT ALL` service_role — same lockdown as the other wheel tables. One upsert per run (every 10 min) — negligible, off the hot path.

### 3.5 Delivery — shared sender
Extract the Telegram send currently duplicated in `lib/telemetry.js` (`sendTelegram`) into an exported **`sendOwnerAlert(text)`** (reuses `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERT_CHAT_ID`, own try/catch, never throws; logs `[telemetry:no-config]` when unset). The monitor uses it. `/api/digest` and the internal `reportError` sender can adopt it later — not refactored here to keep scope tight.

Alert formats:
```
⚠️ Deposit gate: API degraded
42% of checks errored/timed out (last 15m, n=57) — mode: shadow

🚨🚨 Deposit gate: ENFORCE + API DOWN
61% of enforced checks failing (last 15m, n=40) — players are being forced to lose.
Recommend: set DEPOSIT_GATE_MODE=off until BwanaBet recovers.

⚠️ Deposit gate: latency high
p95 eventual latency 1,840ms (last 15m, n=57) — nearing the 2s timeout.

⚠️ Deposit gate: false denials
5 real depositors ruled forced_loss (last 15m) — fail-closed is denying earned wins.

✅ Deposit gate: API degraded — recovered (failRate 4%, n=61)
```

## 4. Affected files

| File | Change |
|------|--------|
| `lib/gateHealth.js` | **New** — pure `evaluateGateHealth` + `decideAlerts` |
| `lib/gateHealth.test.mjs` | **New** — unit tests (no DB) |
| `app/api/gate-monitor/route.js` | **New** — cron endpoint: query → evaluate → decide → send + persist state |
| `lib/telemetry.js` | Extract/export `sendOwnerAlert(text)`; keep existing behavior |
| `supabase/migrations/2026-07-22-gate-monitor-state.sql` | **New** — `wheel_monitor_state` table + lockdown |
| `vercel.json` | Add `/api/gate-monitor` cron (`*/10 * * * *`) |
| `.env.example` | Document `GATE_MONITOR_*` tunables |

## 5. Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `CRON_SECRET` | — | Existing — authenticates the cron call (reused) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALERT_CHAT_ID` | — | Existing — owner DM delivery (reused) |
| `GATE_MONITOR_WINDOW_MIN` | `15` | Lookback window |
| `GATE_MONITOR_MIN_SAMPLE` | `10` | Min checks before rate conditions can fire |
| `GATE_MONITOR_FAIL_RATE_SHADOW` | `0.30` | API-failing threshold in shadow |
| `GATE_MONITOR_FAIL_RATE_ENFORCE` | `0.20` | API-failing threshold in enforce (stricter) |
| `GATE_MONITOR_P95_MS` | `1500` | Latency-p95 threshold |
| `GATE_MONITOR_FALSE_DENIALS` | `3` | False-denial count threshold |
| `GATE_MONITOR_COOLDOWN_MIN` | `30` | Re-alert cooldown per condition |

## 6. Testing

- **Unit (`lib/gateHealth.test.mjs`), no DB:**
  - `evaluateGateHealth`: failure-rate math; p95 over non-null latencies; false-denial detection (`forced_loss` + `eventual_eligible=true`, and NOT counting null-eventual or eligible rows); `MIN_SAMPLE` gating (few errors in a tiny window → no fire); shadow vs enforce threshold selection; `hasEnforce`/`enforceFailureRate`.
  - `decideAlerts`: first-breach → fire; still-firing within cooldown → no-op; still-firing past cooldown → re-fire; breach-cleared → recover; never-fired-and-clear → no-op.
- **Integration (manual, isolated):** seed a throwaway set of `wheel_deposit_checks` rows in a test window (or point at a fixture), hit `/api/gate-monitor` with the cron secret, confirm the right DM(s); confirm a second immediate call is silent (cooldown); confirm no writes to any wheel table except `wheel_monitor_state`.

## 7. Out of scope
- Vercel KV / fixing telemetry gap #1 generally (this feature avoids it by reading the table).
- Extending `/api/digest` to include gate stats (telemetry gap #6 — separate).
- Auto-flipping `DEPOSIT_GATE_MODE` (alerts recommend; a human flips).
- Any change to the gate, spin, or payout logic.
