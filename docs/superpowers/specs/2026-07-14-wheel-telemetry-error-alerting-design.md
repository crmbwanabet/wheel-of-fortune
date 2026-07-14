# Wheel of Fortune — Telemetry & Error Alerting Design

**Date:** 2026-07-14
**Repo:** `crmbwanabet/wheel-of-fortune`
**Deployed at:** `https://wheel-of-fortune-roan.vercel.app`

---

## 1. Goal

Give the wheel a self-built error and telemetry system that:
- **Alerts on errors instantly** — server errors, failed spins, DB/Telegram failures, and any unhandled/unexpected ("future potential") error — pushed to the owner's private Telegram DM.
- **Summarizes activity** — a scheduled daily digest of spins, wins, players, and error counts.
- **Never destabilizes production** — telemetry must not write to the shared Supabase/CRM database, and must never break a spin.

Explicit non-goals: a third-party service (Sentry/Datadog), dashboards, or a live per-event activity stream. Lightweight, Telegram-delivered, owner-facing.

## 2. Constraints (hard)

- **No writes to the shared Supabase DB.** The 2026-07-14 incident showed the wheel can saturate the CRM's database. Telemetry state lives in-process (and optionally Vercel KV later); the digest does only light periodic **reads**.
- **Fire-and-forget, self-isolating.** Every telemetry call is dispatched via `waitUntil` and wrapped in its own try/catch. A telemetry failure can never affect the spin response.
- **Flood-safe.** A storm of identical errors (the incident produced ~4,000 504s) must collapse to a bounded number of messages, never spam the DM or hit Telegram rate limits.

## 3. Delivery

- All alerts and digests go to the **owner's private Telegram DM** via the existing bot `@bwanabet_wheel_wins_bot` (token already in env as `TELEGRAM_BOT_TOKEN`).
- New env var **`TELEGRAM_ALERT_CHAT_ID`** = the owner's personal chat ID. Setup: owner sends the bot any message; capture the chat id from `getUpdates`; set the env var in Vercel (all environments).
- Errors do **not** go to the wins group (`TELEGRAM_CHAT_ID`, the "BwanaBet WoF Manual Deposit" supergroup). Win notifications are unchanged.

## 4. Architecture

### 4.1 Core module — `lib/telemetry.js`

Single responsibility: format and deliver telemetry to Telegram, with flood control. Public surface:

- `reportError(err, context)` — normalize an error into a signature + message, apply dedup/throttle, and (if not suppressed) send an alert to `TELEGRAM_ALERT_CHAT_ID`. `context` carries `{ route, status, code, customerId?, ip?, extra? }`.
- `reportEvent(name, data)` — record a lightweight key-activity event into in-process counters (feeds the health signal; not sent as per-event DMs). Durable activity numbers for the digest come from the DB, not these counters.
- Internal `sendTelegram(chatId, text)` — POST to the Bot API; own try/catch; never throws.

**Dedup / throttle (in-memory, per instance):**
- Keep a module-level `Map<signature, { count, firstAt, lastAlertAt }>`.
- Signature = `route + ':' + errorType/status` (e.g. `spin:504`, `spin:db_error`, `widget:TypeError`).
- On first occurrence of a signature → send immediately.
- Repeats within `ALERT_WINDOW_MS` (default 5 min) → increment `count` silently.
- When the window elapses and `count > 1` → send a rollup: `"<sig> — <count>× in <window>"`, reset the window.
- **Global rate cap:** at most `MAX_ALERTS_PER_MIN` (default 6) messages/minute across all signatures; excess collapsed into a single `"…N more error types suppressed"` line.
- Serverless caveat (documented): warm instances dedup well; cross-instance dupes can slip through, but the global cap bounds total volume. Precise cross-instance dedup is a later upgrade (Vercel KV) — out of scope here.

### 4.2 Server error capture

- **Explicit failure branches** in `app/api/spin/route.js` and `app/api/spin-status/route.js` call `reportError` where they already `console.error` / return 5xx: DB/RPC errors, `server_busy` (57014), `server_error`, `no_state`, Telegram-notify failures.
- **Catch-all wrapper (future-proofing):** wrap each route's `POST` body in `try/catch`; on any otherwise-unhandled throw, `reportError(err, { route, status: 500 })` then return the existing generic 500. This guarantees **new, unanticipated errors** are captured without needing to predict them.
- All `reportError` calls are dispatched with `waitUntil` so they never add latency or failure risk to the response.

### 4.3 Client / widget error capture — `app/api/telemetry/route.js` (new)

- Small POST endpoint that accepts `{ type, message, stack?, context? }` from the browser and forwards to `reportError` (tagged `source: 'widget'`).
- Guardrails: hard body-size limit, IP rate-limited (reuse `checkRateLimit` with a `telemetry` scope), and signature-throttled like server errors so a misbehaving client can't flood. Never touches the wheel DB.
- **Widget hook** in `components/WheelWidget.jsx`: a `window`-level error/unhandledrejection handler and the existing spin-failure paths POST to `/api/telemetry` (fire-and-forget, deduped client-side to one report per error signature per session).

### 4.4 Proactive health signal

- Within the throttle logic, track a short rolling count of 5xx (`server_busy`/timeout/db_error) signatures. If the rate crosses a threshold (e.g. ≥ `HEALTH_ALERT_THRESHOLD` 5xx in 60s), emit a distinct high-priority alert: `"⚠️ Elevated errors on /api/spin — possible DB saturation"` — the early warning the incident lacked. Rate-capped to one such alert per `HEALTH_ALERT_COOLDOWN` (default 10 min).

### 4.5 Daily activity digest — `app/api/digest/route.js` (new)

- Triggered by **Vercel Cron** once daily at **04:10 UTC (06:10 CAT)** — just after the 06:00 CAT wheel-day reset, so it summarizes the day that just closed.
- Secured by a `CRON_SECRET` (Vercel Cron sends it as a header/query; reject otherwise).
- Reads **aggregates only** from the existing tables (single cheap query, once/day): from `wheel_daily_state` and `wheel_spin_log` for the closing wheel-day → `total_spins`, `total_wins`, `total_budget_spent`, distinct players. These activity numbers are exact and durable (they come from the DB).
- **Error totals are best-effort only.** Without a persistent store, in-memory error counters reset when serverless instances recycle, so the digest cannot reliably tally the full day's errors. The digest therefore reports **activity as the reliable content**, and errors are covered by the **instant alerts** (you'll already have seen each one). Precise daily error totals in the digest are a documented KV-upgrade item, not part of this build.
- Posts a digest DM, e.g.:
  ```
  📊 Wheel daily digest — <date>
  Spins: 1,240 | Players: 1,190
  Wins: 18 → K420 / K2,000 budget
  (errors delivered live; see alerts)
  ```
- If a day had zero spins, send a one-line "quiet day" digest (confirms the pipe is alive).

## 5. Configuration

| Env var | Purpose |
|---------|---------|
| `TELEGRAM_BOT_TOKEN` | Existing — reused for alerts/digests |
| `TELEGRAM_ALERT_CHAT_ID` | **New** — owner's private DM chat id |
| `CRON_SECRET` | **New** — authenticates the Vercel Cron call to `/api/digest` |
| Tunables (code constants) | `ALERT_WINDOW_MS`, `MAX_ALERTS_PER_MIN`, `HEALTH_ALERT_THRESHOLD`, `HEALTH_ALERT_COOLDOWN` |

`vercel.json` gains a `crons` entry: `{ "path": "/api/digest", "schedule": "10 4 * * *" }`.

## 6. Affected files

| File | Change |
|------|--------|
| `lib/telemetry.js` | **New** — reportError/reportEvent/sendTelegram + dedup/throttle/rate-cap/health-signal |
| `app/api/spin/route.js` | Catch-all wrapper; `reportError` on failure branches (via `waitUntil`) |
| `app/api/spin-status/route.js` | Catch-all wrapper; `reportError` on failure branches |
| `app/api/telemetry/route.js` | **New** — client/widget error intake → reportError |
| `app/api/digest/route.js` | **New** — cron-triggered daily digest (CRON_SECRET-gated) |
| `components/WheelWidget.jsx` | window error/rejection handler + spin-failure reporter → `/api/telemetry` |
| `vercel.json` | Add `crons` entry for `/api/digest` |
| env | `TELEGRAM_ALERT_CHAT_ID`, `CRON_SECRET` |

## 7. Testing

- **Unit (`lib/telemetry.test.mjs`):** signature derivation; first-occurrence alerts; window rollup counting; global rate cap; health-signal threshold + cooldown; `sendTelegram` never throws on a failed fetch.
- **Integration (manual, isolated):** force a 500 on `/api/spin` (test path) and confirm one DM arrives; fire 100 identical errors and confirm it collapses to ≤ rate cap; hit `/api/digest` with the cron secret and confirm the summary DM; confirm no rows are written to any wheel table by telemetry.

## 8. Out of scope

- Third-party observability (Sentry/Datadog/Better Stack).
- Dashboards, live per-event activity stream, log search UI (Vercel's built-in logs remain the searchable backend for raw logs).
- Vercel KV / precise cross-instance dedup / persistent error history — a documented later upgrade if in-memory proves insufficient.
- Any change to spin logic, payout, or the win-notification path.
