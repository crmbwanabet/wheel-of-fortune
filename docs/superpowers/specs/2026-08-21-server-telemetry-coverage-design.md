# Server-side telemetry coverage, loss reasons, and result acknowledgement

Date: 2026-08-21
Status: approved (owner, 2026-08-21), implementation follows

## Why

Four weeks of `wheel_error_log` hold five distinct signatures — four from the
widget and exactly one from the server. That is not because the server is
flawless; it is because `reportError()` is only called from eight hand-picked
catch blocks. A 2026-08-21 audit of every route, cron, and the `claim_spin`
RPC found eleven failure paths with no listener at all, two of which are
money-shaped:

1. An invalid prize queue at day-init stores `prize_queue = NULL` and returns
   clean losses all day. K0 paid, every monitor green, discovered next
   morning — if the digest delivers.
2. Telegram is the sole alert sink and neither sender checks the response.
   If the bot is revoked or rate-limited, every alert vanishes silently.

Separately, the owner asked whether the hourly prize release is going to
genuine button presses. The data says yes (see "Release-pacing finding"),
but the system cannot currently *prove* that a winner saw their result —
the server learns that a spin was claimed, never that the card rendered.

## Scope

Three changes, one migration, no new external dependencies:

- **Layer 1** — every abnormal server branch, external send, and cron
  internal failure reports through the existing `reportError()` primitive;
  Telegram delivery is verified with the DB as fallback.
- **Layer 2** — `claim_spin` records *why* a spin lost (`loss_reason`), and
  the spin route alerts on the `queue_null` reason (the day-init assertion).
- **Result acknowledgement** — the widget tells the server when the result
  card actually rendered, persisted as `wheel_spin_log.result_seen_at`.

Out of scope: a `/api/health` invariant cron (Layer 3), KV-backed dedup,
client-side blind spots other than the ack, messaging pacing to players.

## Release-pacing finding (context, not a change)

Minute-by-minute traffic on 2026-08-21 is flat across the hour boundary:
15–19 spins/min from 09:55 through 10:19 CAT, no spike at 10:00. Each hour's
20 prizes were consumed in 100–240 s because ~17 spins/min arrive of which
~53 % are deposit-eligible — roughly nine eligible spins a minute, so twenty
prizes last about two minutes by arithmetic alone. Nobody is timing the
hour.

The `/api/spin` request is issued only from `stopWheel()`
(`components/WheelWidget.jsx:815`), reachable only via the wheel's `onClick`
while `screen === 'spinning'` (`:1667`), which itself requires the START
button (`startPlaying`, `:1108`). Two deliberate presses precede every
server-side spin; nothing fires on login or on widget load (the load-time
call is `/api/spin-status`, a read). The gap is on the other side: the
server never learns whether the result rendered. The ack below closes it.

## Design

### Principle

One sink. Every new listening point calls `reportError(err, context)` —
same dedup, same rate cap, same `wheel_error_log` row. Two event kinds:

- **Errors** — something broke. Alert on first occurrence (today's
  behaviour).
- **Signals** — expected in small numbers, meaningful only in volume
  (`invalid_token`, `rate_limited`). New `context.minCount` option: the
  signature is counted silently and alerts only when its count inside the
  5-minute window reaches `minCount`. Rollups thereafter as today.

`token_expired` is deliberately **not** reported — sessions expiring is
normal.

### Layer 1 — new listening points

| Where | `code` | Kind | Notes |
|---|---|---|---|
| `spin` `SPIN_MAINTENANCE=1` | `maintenance` | error, 503 | first hit alerts; 5-min rollups with count while the flag stays on |
| `spin`, `spin-status` bad token | `invalid_token` | signal, `minCount: 10` | `token_expired` not reported |
| `spin` rate-limited | `rate_limited` | signal, `minCount: 20` | |
| `lib/rateLimit.js` RPC error / throw | `ratelimit_rpc_failed` | error | still fails open |
| `spin` win notification failed | `win_notify_failed` | error, 200 | message carries customerId, prize, spin number — the DB row *is* the payout record Telegram missed |
| `gate-monitor` state read error | `monitor_state_read_failed` | error | continue with empty prior state |
| `gate-monitor` state upsert error | `monitor_state_write_failed` | error | |
| `gate-monitor` catch-all | `monitor_query_failed` | error | route now returns **500** |
| `digest` read failure | `digest_read_failed` | error | still sends the "read failed" text |
| `digest` send failure | `digest_send_failed` | error | route returns **500** |
| `digest` unauthorised | — | not reported | Vercel signs cron calls; a 401 is a config error visible in the Vercel log |

**Telegram delivery verification.** `sendOwnerAlert` (telemetry.js),
`sendWinNotification` (telegram.js) and the digest sender all:

1. check `res.ok`, then parse the JSON and check Telegram's own `ok` flag;
2. on failure, write a `telegram_send_failed` row **directly through the
   error sink** (`_errorSink`), never through `reportError` — a dead
   Telegram must not recurse into itself. The row's message carries
   Telegram's `description` and the first 120 chars of the text that was
   lost;
3. return `true`/`false`. Callers that care (spin route, digest) act on
   `false`.

A shared helper `sendTelegram({ token, chatId, text, parseMode })` in
`lib/telegramSend.js` implements 1–3 once; the three senders call it. It
accepts an injectable `fetch` for tests.

**Digest constants.** `app/api/digest/route.js` drops the hardcoded `100`
and `K2,000` for `POOL_SIZE` and `DAILY_BUDGET` from `lib/algorithms.js`.
The "Pot exhausted" line fires on the `POOL_SIZE`-th win.

### Layer 2 — `loss_reason`

Migration `supabase/migrations/2026-08-21-loss-reason-result-seen.sql`,
applied to the CRM project **before** the code deploys. It is additive:
`CREATE OR REPLACE FUNCTION claim_spin` with the **same 15-argument
signature** (no grant churn; the REVOKE/GRANT block is re-applied for
safety), plus two nullable columns. Old code ignores the new return keys.

```sql
ALTER TABLE wheel_spin_log
  ADD COLUMN IF NOT EXISTS loss_reason    text,
  ADD COLUMN IF NOT EXISTS result_seen_at timestamptz;
```

`loss_reason` is NULL on wins. On losses, exactly one of:

| value | when |
|---|---|
| `ineligible` | `p_eligible = false` (deposit gate **or** killswitch — the route's `wheel_deposit_checks` row and `wheel_controls` distinguish them) |
| `cooldown` | recent winner, queue or positions path |
| `cap_reached` | queue mode, pop matched 0 rows, `queue_pos < length` and `queue_pos >= p_release_cap` |
| `pot_empty` | queue mode, pop matched 0 rows, `queue_pos >= length` |
| `queue_null` | queue mode, `prize_queue IS NULL` for the day row |
| `random` | positions mode, no prize at this spin number |

`cap_reached` / `pot_empty` / `queue_null` are resolved by one PK read of
`prize_queue IS NULL, queue_pos, jsonb_array_length(prize_queue)` after a
zero-row pop — losses only, nothing added to the win path. The return
payload gains `'loss_reason', v_loss_reason`.

**Day-init assertion.** In the spin route, `result.loss_reason ===
'queue_null'` → `reportError(new Error('prize_queue is NULL for today'), {
route: 'spin', status: 200, code: 'queue_missing' })`. First spin of a
broken day alerts within seconds instead of next morning.

**Digest line.** After the wins line:
`Losses: cap_reached N · pot_empty N · cooldown N · ineligible N · random N`
(zero-count reasons omitted). Five `head: true` count queries; once a day.

### Result acknowledgement

**Client.** At the moment the result card renders
(`WheelWidget.jsx:634`, `setSpinResult(segment)`), real (non-test) traffic
fires `POST /api/spin-ack` with `{ token, won, prize }` via `fetch(...,
{ keepalive: true })`, fire-and-forget, `.catch(() => {})`. Sent once per
page load (ref guard). The recovery path (`landOnRecordedSpin`) acks the
same way when it lands on a recorded result.

**Route `app/api/spin-ack/route.js`.** POST, `force-dynamic`. Rate limit
`spin-ack` 30/60 s per IP. Token verified with `verifyBwanaToken`; a bad
token returns 401 and is *not* reported (the spin route already reported
it). Then:

```sql
UPDATE wheel_spin_log
SET result_seen_at = now()
WHERE day_date = <today> AND test_bucket = '' AND customer_id = <id>
  AND result_seen_at IS NULL
```

Returns `{ ok: true }` regardless of match count (idempotent, no oracle
for whether a customer spun). DB errors → `reportError(...,
{ route: 'spin-ack', status: 500, code: 'ack_failed' })`, 500.

Body `won`/`prize` are **not trusted or stored** — they are there only so a
future mismatch check can compare against the row; this spec does not add
that check.

**Digest line.** `Wins seen: S / W` where S = wins with `result_seen_at`
non-null. A low ratio is the signal that winners are not seeing their
cards — the question the owner asked.

**Privacy/abuse.** The ack reveals nothing (constant response), writes only
a timestamp to the caller's own row, and is rate-limited. Anon has no grant
on `wheel_spin_log` (2026-08 lockdown) — the route runs service_role.

### Data flow after the change

```
request → abnormal branch → reportError(code, minCount?) → dedup / threshold
        → sendTelegram (verified) ──fail──▶ telegram_send_failed row (via sink)
        → wheel_error_log row (whenever dispatched)

claim_spin loss → loss_reason column + payload → 'queue_null' ⇒ queue_missing alert
result card renders → POST /api/spin-ack → result_seen_at
digest → wins / losses-by-reason / wins-seen
```

## Testing

`node --test lib/*.test.mjs` (existing runner):

- `telemetry.test.mjs`: `minCount` — below threshold returns null and
  persists nothing; at threshold dispatches once with the count; repeats
  roll up as before. `minCount` absent ⇒ behaviour unchanged (existing
  tests keep passing).
- `telegramSend.test.mjs` (new): injected fetch — `res.ok=false`, body
  `{ok:false, description}`, network throw ⇒ returns false and the sink
  receives one `telegram_send_failed` row; `{ok:true}` ⇒ returns true, sink
  untouched.
- `digestLines.test.mjs` (new): pure formatter for the losses and
  wins-seen lines; zero-count reasons omitted; `POOL_SIZE`-th win drives
  the exhaustion line.
- `rateLimit` and route handlers are exercised by the existing
  `scripts/*-verify.mjs` pattern rather than unit tests (they are thin
  Supabase wrappers).

Live verification after `apply_migration`:

1. One `claim_spin` call in test bucket `stress` with `p_release_cap = 0`
   → expect `loss_reason = 'cap_reached'` on the row and in the payload;
   all pre-existing keys unchanged.
2. One real-traffic row acked via `/api/spin-ack` with a test token →
   `result_seen_at` set; second call is a no-op.
3. `npm test` green; `npm run build` green.

No load testing against the shared CRM database (see
`spin-scaling-and-db-load-incident` memory).

## Rollout

1. Apply the migration (additive, safe under the old code).
2. Merge and deploy the code.
3. Watch the owner DM for the first `maintenance`/`invalid_token`
   rollups; tune `minCount` by env if noisy (`TELEMETRY_MINCOUNT_TOKEN`,
   `TELEMETRY_MINCOUNT_RATELIMIT`, defaults 10 / 20).
4. Next-morning digest should show the new `Losses:` and `Wins seen:`
   lines.
