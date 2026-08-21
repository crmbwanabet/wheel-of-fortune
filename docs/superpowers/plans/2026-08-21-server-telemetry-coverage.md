# Server Telemetry Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every abnormal server branch, external send, and cron failure reports through `reportError()`; `claim_spin` records why each spin lost; the widget acknowledges when a result card rendered.

**Architecture:** One new shared Telegram sender (`lib/telegramSend.js`) with response verification and a DB fallback row; `reportError` gains a `minCount` threshold for high-volume signals; a single additive SQL migration adds `loss_reason` + `result_seen_at` to `wheel_spin_log` and re-creates `claim_spin` with the same signature; a new `/api/spin-ack` route stamps `result_seen_at`; the digest reports losses-by-reason and wins-seen.

**Tech Stack:** Next.js 14 app routes, Supabase (Postgres 17, plpgsql), `node:test`, Vercel `waitUntil`, Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-08-21-server-telemetry-coverage-design.md`

**Conventions:**
- Tests: `node --test lib/<name>.test.mjs` (all: `npm test`). ESM, `node:assert/strict`.
- Telemetry state is module-level: every test starts with `_resetTelemetry()`.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Branch: `feat/server-telemetry-coverage` (already created, spec committed).

---

## File map

| File | Responsibility |
|---|---|
| Create `lib/telegramSend.js` | `sendTelegram()` — one verified Telegram send; writes `telegram_send_failed` via an injectable sink on failure |
| Create `lib/telegramSend.test.mjs` | tests for the above |
| Modify `lib/telemetry.js` | `sendOwnerAlert` → `sendTelegram`; `minCount` option; export `_errorSink` getter for the sender |
| Modify `lib/telemetry.test.mjs` | `minCount` tests |
| Modify `lib/telegram.js` | `sendWinNotification` → `sendTelegram`, returns boolean; `DAILY_BUDGET` in text |
| Modify `lib/rateLimit.js` | report RPC failures |
| Create `lib/digestLines.js` + `.test.mjs` | pure formatters: losses line, wins-seen line, exhaustion predicate |
| Modify `app/api/spin/route.js` | maintenance / invalid_token / rate_limited / win_notify_failed / queue_missing |
| Modify `app/api/spin-status/route.js` | invalid_token signal |
| Modify `app/api/gate-monitor/route.js` | state read/write errors; 500 on failure |
| Modify `app/api/digest/route.js` | constants, reportError, verified send, new lines, 500 on failure |
| Create `supabase/migrations/2026-08-21-loss-reason-result-seen.sql` | columns + `claim_spin` with `loss_reason` |
| Create `app/api/spin-ack/route.js` | result acknowledgement |
| Modify `components/WheelWidget.jsx` | fire the ack when the result card renders |

---

### Task 1: Shared verified Telegram sender

**Files:**
- Create: `lib/telegramSend.js`
- Create: `lib/telegramSend.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// lib/telegramSend.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendTelegram } from './telegramSend.js';

const okFetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
const httpFailFetch = async () => ({ ok: false, status: 403, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }) });
const apiFailFetch = async () => ({ ok: true, json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) });
const throwFetch = async () => { throw new Error('ECONNRESET'); };

function capture() {
  const rows = [];
  return { rows, sink: async (row) => { rows.push(row); } };
}

test('returns true and writes nothing when Telegram accepts', async () => {
  const c = capture();
  const ok = await sendTelegram({ token: 't', chatId: '1', text: 'hi', fetchImpl: okFetch, sink: c.sink });
  assert.equal(ok, true);
  assert.equal(c.rows.length, 0);
});

test('HTTP failure → false + one telegram_send_failed row with the description', async () => {
  const c = capture();
  const ok = await sendTelegram({ token: 't', chatId: '1', text: 'lost alert text', fetchImpl: httpFailFetch, sink: c.sink });
  assert.equal(ok, false);
  assert.equal(c.rows.length, 1);
  assert.equal(c.rows[0].code, 'telegram_send_failed');
  assert.equal(c.rows[0].signature, 'telegram:telegram_send_failed');
  assert.equal(c.rows[0].status, 403);
  assert.match(c.rows[0].message, /blocked by the user/);
  assert.match(c.rows[0].message, /lost alert text/);
});

test('{ok:false} body → false + row even when HTTP 200', async () => {
  const c = capture();
  const ok = await sendTelegram({ token: 't', chatId: '1', text: 'x', fetchImpl: apiFailFetch, sink: c.sink });
  assert.equal(ok, false);
  assert.match(c.rows[0].message, /chat not found/);
});

test('network throw → false + row, never throws', async () => {
  const c = capture();
  const ok = await sendTelegram({ token: 't', chatId: '1', text: 'x', fetchImpl: throwFetch, sink: c.sink });
  assert.equal(ok, false);
  assert.match(c.rows[0].message, /ECONNRESET/);
});

test('missing config → false, no row, no fetch', async () => {
  const c = capture();
  let called = false;
  const ok = await sendTelegram({ token: '', chatId: '', text: 'x', fetchImpl: async () => { called = true; }, sink: c.sink });
  assert.equal(ok, false);
  assert.equal(called, false);
  assert.equal(c.rows.length, 0);
});

test('a failing sink is swallowed', async () => {
  const ok = await sendTelegram({ token: 't', chatId: '1', text: 'x', fetchImpl: throwFetch, sink: async () => { throw new Error('db down'); } });
  assert.equal(ok, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test lib/telegramSend.test.mjs`
Expected: FAIL — `Cannot find module './telegramSend.js'`

- [ ] **Step 3: Implement**

```js
// lib/telegramSend.js
//
// The ONE place the wheel talks to Telegram. Both alert channels (owner DM,
// win group) and the digest go through here so delivery is verified in one
// spot. Telegram answers HTTP 200 with {ok:false} for many failures, so
// res.ok alone is not enough — both are checked.
//
// On failure a `telegram_send_failed` row is written straight through the
// error sink, deliberately NOT via reportError(): reportError would try to
// Telegram the failure, which is the thing that just failed. The DB row is
// the fallback channel, and it survives Telegram being dead.
import { getSupabase } from './supabase.js';

async function defaultSink(row) {
  await getSupabase().from('wheel_error_log').insert(row);
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Returns true only when Telegram confirmed delivery. Never throws.
export async function sendTelegram({
  token,
  chatId,
  text,
  parseMode = null,
  disablePreview = true,
  fetchImpl = fetch,
  sink = defaultSink,
  source = null,
}) {
  if (!token || !chatId) {
    console.log('[telegram:no-config]', String(text).split('\n')[0]);
    return false;
  }
  let status = null;
  let description = null;
  try {
    const body = { chat_id: chatId, text, disable_web_page_preview: disablePreview };
    if (parseMode) body.parse_mode = parseMode;
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    status = res.status ?? null;
    const json = await res.json().catch(() => null);
    if (res.ok && json && json.ok === true) return true;
    description = (json && json.description) || `HTTP ${status}`;
  } catch (err) {
    description = (err && err.message) || 'fetch threw';
  }
  try {
    await sink({
      signature: 'telegram:telegram_send_failed',
      route: 'telegram',
      code: 'telegram_send_failed',
      status: Number(status) || null,
      customer_id: null,
      message: truncate(`${description} — lost: ${truncate(text, 120)}`, 500),
      occurrences: 1,
      source,
      host: null,
    });
  } catch (e) {
    console.error('[telegram] fallback persist failed:', e && e.message);
  }
  return false;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test lib/telegramSend.test.mjs`
Expected: 6 passing

- [ ] **Step 5: Commit**

```bash
git add lib/telegramSend.js lib/telegramSend.test.mjs
git commit -m "feat(telemetry): shared verified Telegram sender with DB fallback row

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `reportError` uses the sender and gains `minCount`

**Files:**
- Modify: `lib/telemetry.js`
- Modify: `lib/telemetry.test.mjs`

- [ ] **Step 1: Write the failing tests** (append to `lib/telemetry.test.mjs`)

```js
test('minCount: below threshold is counted silently and persists nothing', async () => {
  _resetTelemetry();
  const rows = [];
  _setErrorSink(async (r) => { rows.push(r); });
  const ctx = { route: 'spin', status: 401, code: 'invalid_token', minCount: 3 };
  assert.equal(await reportError(new Error('bad'), ctx, 1000), null);
  assert.equal(await reportError(new Error('bad'), ctx, 2000), null);
  assert.equal(rows.length, 0);
});

test('minCount: reaching the threshold dispatches once with the count', async () => {
  _resetTelemetry();
  const rows = [];
  _setErrorSink(async (r) => { rows.push(r); });
  const ctx = { route: 'spin', status: 401, code: 'invalid_token', minCount: 3 };
  await reportError(new Error('bad'), ctx, 1000);
  await reportError(new Error('bad'), ctx, 2000);
  const t = await reportError(new Error('bad'), ctx, 3000);
  assert.ok(t && t.includes('spin:invalid_token'));
  assert.ok(/3×/.test(t));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].occurrences, 3);
  // 4th within the window: counted, not re-sent
  assert.equal(await reportError(new Error('bad'), ctx, 4000), null);
});

test('minCount: after the window a rollup is sent only if the new count reaches the threshold', async () => {
  _resetTelemetry();
  const ctx = { route: 'spin', status: 429, code: 'rate_limited', minCount: 2 };
  await reportError(new Error('x'), ctx, 1000);
  await reportError(new Error('x'), ctx, 2000);            // dispatches (2)
  const late = 1000 + 6 * 60 * 1000;
  assert.equal(await reportError(new Error('x'), ctx, late), null);        // 1 in new window
  const t = await reportError(new Error('x'), ctx, late + 1000);           // 2 → rollup
  assert.ok(t && /2×/.test(t));
});

test('minCount absent: first occurrence still alerts immediately (unchanged)', async () => {
  _resetTelemetry();
  const t = await reportError(new Error('boom'), { route: 'spin', status: 500, code: 'claim_failed' }, 1000);
  assert.ok(t && t.includes('spin:claim_failed'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test lib/telemetry.test.mjs`
Expected: the three `minCount` tests FAIL (first occurrence alerts regardless of `minCount`).

- [ ] **Step 3: Implement** — three edits in `lib/telemetry.js`

(a) Replace the import line and `sendOwnerAlert`:

```js
import { getSupabase } from './supabase.js';
import { sendTelegram } from './telegramSend.js';
```

```js
// Send a plain-text alert to the owner's Telegram DM. Never throws. Returns
// true only when Telegram confirmed delivery; on failure a
// telegram_send_failed row is written through the error sink (see
// telegramSend.js for why that path bypasses reportError).
export async function sendOwnerAlert(text) {
  return sendTelegram({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_ALERT_CHAT_ID,
    text,
    sink: (row) => _errorSink(row),
  });
}
```

(b) Replace the per-signature dedup block inside `reportError` (from `// --- Per-signature dedup/throttle ---` to the closing `return null;` before the `catch`):

```js
    // --- Per-signature dedup/throttle ---
    // minCount > 1 marks a SIGNAL: expected in small numbers, meaningful only
    // in volume (bad tokens, rate limiting). Counted silently until the count
    // inside the window reaches minCount, then dispatched once with the count.
    const minCount = Math.max(1, Number(context.minCount) || 1);
    const st = _state.sig.get(sig);
    if (!st) {
      _state.sig.set(sig, { count: 1, firstAt: now, lastAlertAt: now, dispatched: minCount <= 1 });
      if (minCount <= 1 && underRateCap(now)) {
        const text = formatAlert(sig, message, context);
        await sendOwnerAlert(text);
        await persistError(context, message, 1);
        return text;
      }
      return null;
    }

    st.count += 1;
    const windowElapsed = now - st.lastAlertAt >= ALERT_WINDOW_MS;

    if (minCount > 1 && !st.dispatched) {
      // Signal still below threshold in the current window.
      if (windowElapsed) { st.count = 1; st.lastAlertAt = now; return null; }
      if (st.count < minCount) return null;
      st.dispatched = true;
      const total = st.count;
      st.count = 0;
      st.lastAlertAt = now;
      if (underRateCap(now)) {
        const text = `🔴 ${sig} — ${total}× in the last ${Math.round(ALERT_WINDOW_MS / 60000)} min\n${truncate(message)}`;
        await sendOwnerAlert(text);
        await persistError(context, message, total);
        return text;
      }
      return null;
    }

    if (windowElapsed) {
      const total = st.count;
      if (minCount > 1 && total < minCount) {
        // New window for a signal: start counting again from this event.
        st.count = 1; st.lastAlertAt = now; st.dispatched = false;
        return null;
      }
      st.count = 0;
      st.lastAlertAt = now;
      if (underRateCap(now)) {
        const mins = Math.round(ALERT_WINDOW_MS / 60000);
        const text = `🔴 ${sig} — ${total}× in the last ${mins} min\n${truncate(message)}`;
        await sendOwnerAlert(text);
        await persistError(context, message, total);
        return text;
      }
    }
    return null;
```

(c) No other change. `_errorSink` is already module-scoped and used by `persistError`; `sendOwnerAlert` references it lazily via the arrow, so the existing `_setErrorSink` in tests captures Telegram failures too.

- [ ] **Step 4: Run all telemetry tests**

Run: `node --test lib/telemetry.test.mjs`
Expected: all passing, including the pre-existing dedup/rollup/rate-cap tests.

- [ ] **Step 5: Commit**

```bash
git add lib/telemetry.js lib/telemetry.test.mjs
git commit -m "feat(telemetry): verified owner alerts; minCount threshold for high-volume signals

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Win notifications verified; rate limiter reports

**Files:**
- Modify: `lib/telegram.js`
- Modify: `lib/rateLimit.js`

- [ ] **Step 1: Replace `sendWinNotification` in `lib/telegram.js`**

```js
import { WINNABLE_POSITIONS, POOL_SIZE, DAILY_BUDGET } from './algorithms.js';
import { sendTelegram } from './telegramSend.js';
```

In `formatWinMessage`, replace the literal `K2,000` with `K${DAILY_BUDGET.toLocaleString('en-US')}`:

```js
    `📈 Daily: ${winsToday}/${poolSize} wins | K${budgetSpent}/K${DAILY_BUDGET.toLocaleString('en-US')} budget`,
```

```js
// Returns true only when Telegram confirmed delivery. The caller (spin route)
// reports false as win_notify_failed so a paid-out win always has a record.
export async function sendWinNotification({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber, payoutMode, poolSize }) {
  const message = formatWinMessage({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber, payoutMode, poolSize });
  return sendTelegram({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    text: message,
    parseMode: 'HTML',
    source: 'win',
  });
}
```

- [ ] **Step 2: Run the existing telegram tests**

Run: `node --test lib/telegram.test.mjs`
Expected: passing (they test `formatWinMessage`; if one asserts the literal `K2,000` it still matches since `DAILY_BUDGET` is 2000).

- [ ] **Step 3: Report limiter failures in `lib/rateLimit.js`**

```js
import { getSupabase } from './supabase';
import { reportError } from './telemetry.js';

export async function checkRateLimit(scope, ip, limit = 5, windowSec = 60) {
  if (!ip || ip === 'unknown') return true; // Can't enforce without an IP
  try {
    const { data, error } = await getSupabase().rpc('check_rate_limit', {
      p_scope: scope,
      p_ip: ip,
      p_limit: limit,
      p_window_sec: windowSec,
    });
    if (error) {
      // Fail open — but a limiter that cannot reach the DB is an incident signal.
      reportError(error, { route: scope, status: 200, code: 'ratelimit_rpc_failed' });
      return true;
    }
    return data === true;
  } catch (err) {
    reportError(err, { route: scope, status: 200, code: 'ratelimit_rpc_failed' });
    return true;
  }
}
```

(Not awaited on purpose: the limiter is on the hot path, and `reportError` never throws.)

- [ ] **Step 4: Commit**

```bash
git add lib/telegram.js lib/rateLimit.js
git commit -m "feat(telemetry): verified win notifications; report rate-limiter RPC failures

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Spin route listening points

**Files:**
- Modify: `app/api/spin/route.js`

- [ ] **Step 1: Add env-tunable thresholds** after the `SPIN_COOLDOWN_DAYS` line:

```js
// Signal thresholds: these conditions are normal in ones and twos and only
// matter in volume, so they alert when the 5-min count reaches the threshold.
const MINCOUNT_TOKEN = Number(process.env.TELEMETRY_MINCOUNT_TOKEN) || 10;
const MINCOUNT_RATELIMIT = Number(process.env.TELEMETRY_MINCOUNT_RATELIMIT) || 20;
```

- [ ] **Step 2: Maintenance flag** — replace the first block of `handleSpin`:

```js
  if (process.env.SPIN_MAINTENANCE === '1') {
    // The wheel is deliberately down. One alert, then 5-min rollups with the
    // count of rejected spins for as long as the flag stays on.
    waitUntil(reportError(new Error('SPIN_MAINTENANCE=1 — spins rejected'), { route: 'spin', status: 503, code: 'maintenance' }));
    return NextResponse.json({ error: 'maintenance' }, { status: 503 });
  }
```

- [ ] **Step 3: Rate-limited** — replace the limiter block:

```js
  if (!isTest && !(await checkRateLimit('spin', ip, SPIN_RATE_LIMIT, SPIN_RATE_WINDOW_SEC))) {
    waitUntil(reportError(new Error(`rate limited ip=${ip}`), { route: 'spin', status: 429, code: 'rate_limited', minCount: MINCOUNT_RATELIMIT }));
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }
```

- [ ] **Step 4: Bad token** — replace the `catch (err)` of the token verification:

```js
    } catch (err) {
      const code = err instanceof TokenError && err.code === 'expired' ? 'token_expired' : 'invalid_token';
      // Expired sessions are normal. A burst of INVALID tokens is not — it is
      // what a BwanaBet token-format change looks like from here.
      if (code === 'invalid_token') {
        waitUntil(reportError(err, { route: 'spin', status: 401, code: 'invalid_token', minCount: MINCOUNT_TOKEN }));
      }
      return NextResponse.json({ error: code }, { status: 401 });
    }
```

- [ ] **Step 5: Day-init assertion** — insert immediately after the `if (result.error) { ... }` block:

```js
  // Day-init assertion. A queue that failed validation is stored as NULL and
  // every spin then loses normally — K0 paid, all monitors green. The RPC now
  // names that loss, so the FIRST spin of a broken day alerts.
  if (result.loss_reason === 'queue_null') {
    waitUntil(reportError(new Error(`prize_queue is NULL for ${dayDate} bucket='${bucket}'`), { route: 'spin', status: 200, code: 'queue_missing' }));
  }
```

- [ ] **Step 6: Win notification failure** — replace the `sendWinNotification` call:

```js
  if (result.win && !isTest) {
    waitUntil(
      sendWinNotification({
        customerId: cleanId,
        prizeAmount: result.prize_amount,
        winsToday: result.wins_today,
        budgetSpent: result.budget_today,
        spinNumber: result.spin_number,
        payoutMode: WHEEL_PAYOUT_MODE,
        poolSize: prizeQueue.length,
      }).then((delivered) => {
        if (!delivered) {
          // The DB row is the payout record the ops group never received.
          return reportError(
            new Error(`win notification not delivered: customer=${cleanId} prize=K${result.prize_amount} spin=${result.spin_number} win#${result.wins_today}`),
            { route: 'spin', status: 200, code: 'win_notify_failed', customerId: cleanId },
          );
        }
      }).catch((err) => reportError(err, { route: 'spin', status: 200, code: 'win_notify_failed', customerId: cleanId }))
    );
  }
```

- [ ] **Step 7: Build check**

Run: `npm run build`
Expected: compiles. (No unit tests cover the route; Task 12 verifies live.)

- [ ] **Step 8: Commit**

```bash
git add app/api/spin/route.js
git commit -m "feat(spin): report maintenance, bad tokens, rate limiting, lost win notifications, missing queue

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: spin-status bad-token signal

**Files:**
- Modify: `app/api/spin-status/route.js`

- [ ] **Step 1: Add the threshold constant** after the imports:

```js
const MINCOUNT_TOKEN = Number(process.env.TELEMETRY_MINCOUNT_TOKEN) || 10;
```

- [ ] **Step 2: Replace the token `catch`:**

```js
  } catch (err) {
    const code = err instanceof TokenError && err.code === 'expired' ? 'token_expired' : 'invalid_token';
    if (code === 'invalid_token') {
      waitUntil(reportError(err, { route: 'spin-status', status: 401, code: 'invalid_token', minCount: MINCOUNT_TOKEN }));
    }
    return NextResponse.json({ available: false, error: code, reason: code }, { status: 401 });
  }
```

- [ ] **Step 3: Commit**

```bash
git add app/api/spin-status/route.js
git commit -m "feat(spin-status): report invalid-token bursts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: gate-monitor state errors and honest status code

**Files:**
- Modify: `app/api/gate-monitor/route.js`

- [ ] **Step 1: State read** — replace the `wheel_monitor_state` select:

```js
    const { data: stateRows, error: stateErr } = await supabase
      .from('wheel_monitor_state')
      .select('condition,firing,last_alert_at');
    if (stateErr) {
      // Continue with empty prior state (every firing condition re-alerts),
      // but say so — otherwise recoveries are silently dropped.
      waitUntil(reportError(stateErr, { route: 'gate-monitor', status: 200, code: 'monitor_state_read_failed' }));
    }
```

- [ ] **Step 2: State write** — replace the upsert line:

```js
    const { error: upsertErr } = await supabase.from('wheel_monitor_state').upsert(upserts, { onConflict: 'condition' });
    if (upsertErr) {
      // State did not advance: the same alert will repeat next run.
      waitUntil(reportError(upsertErr, { route: 'gate-monitor', status: 200, code: 'monitor_state_write_failed' }));
    }
```

- [ ] **Step 3: Catch-all returns 500** — replace the final `return` in the `catch`:

```js
    return NextResponse.json({ ok: false }, { status: 500 });
```

- [ ] **Step 4: Commit**

```bash
git add app/api/gate-monitor/route.js
git commit -m "feat(gate-monitor): report state read/write failures; 500 on internal failure

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Digest line formatters (pure)

**Files:**
- Create: `lib/digestLines.js`
- Create: `lib/digestLines.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// lib/digestLines.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lossesLine, winsSeenLine, potExhausted, LOSS_REASONS } from './digestLines.js';

test('LOSS_REASONS is the fixed ordered vocabulary', () => {
  assert.deepEqual(LOSS_REASONS, ['cap_reached', 'pot_empty', 'queue_null', 'cooldown', 'ineligible', 'random']);
});

test('lossesLine lists non-zero reasons in order, omits zeros', () => {
  assert.equal(
    lossesLine({ cap_reached: 166, cooldown: 14, ineligible: 170, random: 0 }),
    'Losses: cap_reached 166 · cooldown 14 · ineligible 170',
  );
});

test('lossesLine returns null when nothing to say', () => {
  assert.equal(lossesLine({}), null);
  assert.equal(lossesLine({ random: 0 }), null);
});

test('lossesLine ignores unknown keys', () => {
  assert.equal(lossesLine({ bogus: 5, pot_empty: 1 }), 'Losses: pot_empty 1');
});

test('winsSeenLine shows seen/total and flags a low ratio', () => {
  assert.equal(winsSeenLine(18, 20), 'Wins seen: 18 / 20');
  assert.equal(winsSeenLine(9, 20), 'Wins seen: 9 / 20 ⚠️ below 75%');
  assert.equal(winsSeenLine(0, 0), null);
});

test('potExhausted is true at POOL_SIZE wins, not before', () => {
  assert.equal(potExhausted(199, 200), false);
  assert.equal(potExhausted(200, 200), true);
  assert.equal(potExhausted(null, 200), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test lib/digestLines.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// lib/digestLines.js
// Pure formatters for the daily digest. No I/O; the route fetches the counts.

// Fixed order so the line reads the same every day. Mirrors the values
// claim_spin writes to wheel_spin_log.loss_reason.
export const LOSS_REASONS = ['cap_reached', 'pot_empty', 'queue_null', 'cooldown', 'ineligible', 'random'];

export function lossesLine(counts = {}) {
  const parts = LOSS_REASONS
    .filter((r) => Number(counts[r]) > 0)
    .map((r) => `${r} ${Number(counts[r])}`);
  return parts.length ? `Losses: ${parts.join(' · ')}` : null;
}

// Share of winners whose result card actually rendered. Below this ratio
// something is swallowing results between the server and the player's eyes.
const WINS_SEEN_WARN_RATIO = 0.75;

export function winsSeenLine(seen, wins) {
  const w = Number(wins) || 0;
  if (w <= 0) return null;
  const s = Number(seen) || 0;
  const base = `Wins seen: ${s} / ${w}`;
  return s / w < WINS_SEEN_WARN_RATIO ? `${base} ⚠️ below ${Math.round(WINS_SEEN_WARN_RATIO * 100)}%` : base;
}

export function potExhausted(totalWins, poolSize) {
  return (Number(totalWins) || 0) >= poolSize;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test lib/digestLines.test.mjs`
Expected: 6 passing

- [ ] **Step 5: Commit**

```bash
git add lib/digestLines.js lib/digestLines.test.mjs
git commit -m "feat(digest): pure formatters for losses-by-reason and wins-seen lines

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Digest route — constants, reporting, verified send, new lines

**Files:**
- Modify: `app/api/digest/route.js`

- [ ] **Step 1: Replace the imports**

```js
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSupabase } from '@/lib/supabase';
import { getWheelDayDate, WINNABLE_POSITIONS, POOL_SIZE, DAILY_BUDGET } from '@/lib/algorithms';
import { cooldownDigestLines } from '@/lib/cooldownDigest';
import { shiftWheelDay } from '@/lib/cooldown';
import { reportError } from '@/lib/telemetry';
import { sendTelegram } from '@/lib/telegramSend';
import { lossesLine, winsSeenLine, potExhausted, LOSS_REASONS } from '@/lib/digestLines';
```

- [ ] **Step 2: Replace the body of `handleDigest` from `let text;` to the end of the function**

```js
  let text;
  let readFailed = false;
  try {
    const supabase = getSupabase();
    const base = (q) => q.eq('day_date', day).eq('test_bucket', '');
    const countWhere = async (apply) => {
      const { count, error } = await apply(base(supabase.from('wheel_spin_log').select('id', { count: 'exact', head: true })));
      if (error) throw error;
      return count ?? 0;
    };

    const { data: state, error: stateErr } = await base(
      supabase.from('wheel_daily_state').select('total_wins,total_budget_spent,carryover_in'),
    ).maybeSingle();
    if (stateErr) throw stateErr;

    // Spin count = one row per spin. wheel_daily_state.total_spins is NOT
    // maintained (would be a hot-row contention point).
    const spins = await countWhere((q) => q);
    if (spins === 0) {
      text = `📊 Wheel daily digest — ${day}\nQuiet day: 0 spins.`;
    } else {
      const cooldownBlocked = await countWhere((q) => q.eq('cooldown_blocked', true));
      const carryoverAwarded = await countWhere((q) => q.eq('carryover_awarded', true));
      const winsSeen = await countWhere((q) => q.eq('won', true).not('result_seen_at', 'is', null));
      const lossCounts = {};
      for (const r of LOSS_REASONS) lossCounts[r] = await countWhere((q) => q.eq('loss_reason', r));

      const queueMode = process.env.WHEEL_PAYOUT_MODE === 'queue';
      const totalWins = state?.total_wins ?? 0;
      let spinsLine;
      let exhaustLine = null;
      if (queueMode) {
        spinsLine = `Spins: ${spins}`;
        // Pot exhausted = the POOL_SIZE-th win; its timestamp says when the
        // day's budget ran out.
        if (potExhausted(totalWins, POOL_SIZE)) {
          const { data: last } = await base(
            supabase.from('wheel_spin_log').select('created_at').eq('won', true).order('created_at', { ascending: true }),
          ).range(POOL_SIZE - 1, POOL_SIZE - 1);
          if (last?.[0]?.created_at) {
            const catMs = Date.parse(last[0].created_at) + 2 * 60 * 60 * 1000;
            exhaustLine = `Pot exhausted at ${new Date(catMs).toISOString().slice(11, 16)} CAT`;
          }
        }
      } else {
        const beyond = Math.max(0, spins - WINNABLE_POSITIONS);
        spinsLine = beyond > 0
          ? `Spins: ${spins} (first ${WINNABLE_POSITIONS} winnable, ${beyond} past cap)`
          : `Spins: ${spins} / ${WINNABLE_POSITIONS} winnable`;
      }
      const lines = [
        `📊 Wheel daily digest — ${day}`,
        spinsLine,
        `Wins: ${totalWins} → K${state?.total_budget_spent ?? 0} / K${DAILY_BUDGET.toLocaleString('en-US')} budget`,
      ];
      if (exhaustLine) lines.push(exhaustLine);
      const ws = winsSeenLine(winsSeen, totalWins);
      if (ws) lines.push(ws);
      const ll = lossesLine(lossCounts);
      if (ll) lines.push(ll);
      lines.push(...cooldownDigestLines(cooldownBlocked, carryoverAwarded, state?.carryover_in));
      lines.push(`(errors delivered live; see alerts)`);
      text = lines.join('\n');
    }
  } catch (err) {
    readFailed = true;
    waitUntil(reportError(err, { route: 'digest', status: 500, code: 'digest_read_failed' }));
    text = `📊 Wheel daily digest — ${day}\n⚠️ digest read failed: ${(err && err.message) || 'error'}`;
  }

  const delivered = await sendTelegram({ token, chatId, text, source: 'digest' });
  if (!delivered) {
    waitUntil(reportError(new Error('digest not delivered'), { route: 'digest', status: 500, code: 'digest_send_failed' }));
  }
  // An honest status code: Vercel's cron log should show a digest that did
  // not read or did not send as a failure, not a success.
  const ok = delivered && !readFailed;
  return NextResponse.json({ ok, day }, { status: ok ? 200 : 500 });
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add app/api/digest/route.js
git commit -m "feat(digest): POOL_SIZE/DAILY_BUDGET, losses-by-reason, wins-seen, verified send, honest status

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Migration — `loss_reason`, `result_seen_at`, `claim_spin`

**Files:**
- Create: `supabase/migrations/2026-08-21-loss-reason-result-seen.sql`

- [ ] **Step 1: Create the file.** Start with this header, then paste the **entire** `CREATE OR REPLACE FUNCTION public.claim_spin(...)` from `supabase/migrations/2026-08-19-prize-ladder-pacing-jackpot.sql` (from `CREATE OR REPLACE FUNCTION` through `$function$;`, identical signature and settings), then apply the six edits in Step 2, then append the REVOKE/GRANT block from Step 3.

```sql
-- Wheel of Fortune — loss reasons + result acknowledgement
-- Date: 2026-08-21   Spec: docs/superpowers/specs/2026-08-21-server-telemetry-coverage-design.md
--
-- Additive. Same claim_spin signature as 2026-08-19, so it is safe to apply
-- BEFORE the code deploys: old code ignores the new return key.
--
--   loss_reason     why a spin lost (NULL on wins). Makes cap_reached /
--                   pot_empty / queue_null distinguishable — today all three
--                   are byte-identical losses.
--   result_seen_at  stamped by /api/spin-ack when the widget rendered the
--                   result card. NULL = the server never heard back.

BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE public.wheel_spin_log
  ADD COLUMN IF NOT EXISTS loss_reason    text,
  ADD COLUMN IF NOT EXISTS result_seen_at timestamptz;

-- (claim_spin body pasted below, edited per the plan)
```

- [ ] **Step 2: Six edits inside the pasted function body**

(1) In the `DECLARE` block, after `v_popped text;` add:

```sql
  v_loss_reason text;
  v_q_null boolean;
  v_q_pos int;
  v_q_len int;
```

(2) Queue path, ineligible branch — after `v_is_win := false;` inside `IF NOT p_eligible THEN` add:

```sql
      v_loss_reason := 'ineligible';
```

(3) Queue path, cooldown branch — after `v_cooldown_blocked := true;` inside `IF v_in_cooldown THEN` add:

```sql
        v_loss_reason := 'cooldown';
```

(4) Queue path, after `v_is_win := v_prize IS NOT NULL;` (the line following the atomic pop's `INTO v_prize, v_wins, v_budget;`) add:

```sql
        IF NOT v_is_win THEN
          -- Zero-row pop: name the cause. One PK read, losses only.
          SELECT prize_queue IS NULL, queue_pos, COALESCE(jsonb_array_length(prize_queue), 0)
          INTO v_q_null, v_q_pos, v_q_len
          FROM wheel_daily_state
          WHERE day_date = p_day AND test_bucket = p_bucket;
          v_loss_reason := CASE
            WHEN v_q_null THEN 'queue_null'
            WHEN v_q_pos >= v_q_len THEN 'pot_empty'
            ELSE 'cap_reached'
          END;
        END IF;
```

(5) Positions path — replace the two lines of the final `ELSE` (before `END IF;` that closes the `IF p_force_prize ... ELSIF p_payout_mode = 'queue'` chain):

```sql
  ELSE
    v_prize := NULLIF(v_map ->> v_spin_number::text, '')::int;
    v_is_win := v_prize IS NOT NULL;
    IF NOT v_is_win THEN v_loss_reason := 'random'; END IF;
  END IF;
```

Then in the positions-path deposit-gate block (`IF v_is_win AND NOT p_eligible THEN`) add `v_loss_reason := 'ineligible';` after `v_forced_ineligible := true;`, and in the positions-path cooldown block (`IF v_in_cooldown THEN` under `IF p_payout_mode <> 'queue' AND v_is_win ...`) add `v_loss_reason := 'cooldown';` after `v_cooldown_blocked := true;`. In the carryover award block, after `v_carryover_awarded := true;` add `v_loss_reason := NULL;`.

(6) The `INSERT INTO wheel_spin_log` and the `RETURN`:

```sql
  INSERT INTO wheel_spin_log (
    day_date, test_bucket, customer_id, spin_number,
    won, prize_amount, segment_index, fingerprint, ip_address,
    cooldown_blocked, carryover_awarded, loss_reason
  ) VALUES (
    p_day, p_bucket, p_customer, v_spin_number,
    v_is_win, COALESCE(v_prize, 0), v_segment, p_fingerprint, p_ip,
    v_cooldown_blocked, v_carryover_awarded,
    CASE WHEN v_is_win THEN NULL ELSE v_loss_reason END
  );

  RETURN jsonb_build_object(
    'win', v_is_win,
    'segment_index', v_segment,
    'prize_amount', v_prize,
    'spin_number', v_spin_number,
    'wins_today', v_wins,
    'budget_today', v_budget,
    'forced_loss_ineligible', v_forced_ineligible,
    'forced_loss_cooldown', v_cooldown_blocked,
    'carryover_awarded', v_carryover_awarded,
    'loss_reason', CASE WHEN v_is_win THEN NULL ELSE v_loss_reason END
  );
```

- [ ] **Step 3: Append the grant block and commit the transaction**

```sql
REVOKE ALL ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer, text, jsonb, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer, text, jsonb, integer, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer, text, jsonb, integer, text) TO service_role;

COMMIT;
```

- [ ] **Step 4: Sanity-check the file**

Run: `grep -c "v_loss_reason" supabase/migrations/2026-08-21-loss-reason-result-seen.sql`
Expected: at least 11 (declare, 6 assignments in queue/positions paths, carryover reset, insert, return ×2).

Run: `grep -n "loss_reason\|result_seen_at" supabase/migrations/2026-08-21-loss-reason-result-seen.sql | head -3`
Expected: the two `ADD COLUMN` lines appear before the function.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-08-21-loss-reason-result-seen.sql
git commit -m "feat(db): loss_reason + result_seen_at on wheel_spin_log; claim_spin names every loss

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: `/api/spin-ack` route

**Files:**
- Create: `app/api/spin-ack/route.js`

- [ ] **Step 1: Create the route**

```js
import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSupabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rateLimit';
import { getWheelDayDate } from '@/lib/algorithms';
import { verifyBwanaToken } from '@/lib/bwanaAuth.mjs';
import { reportError } from '@/lib/telemetry';

export const preferredRegion = ['dub1'];
export const dynamic = 'force-dynamic';

// The widget calls this the moment the result card renders. It is the only
// evidence the server has that a spin's outcome reached the player's eyes.
//
// Constant response on purpose: whether or not a row matched, {ok:true}. The
// endpoint must not be an oracle for "has this customer spun today". It writes
// one timestamp to the caller's own row and nothing else.
export async function POST(request) {
  try {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!(await checkRateLimit('spin-ack', ip, 30, 60))) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
    }

    let customerId;
    try {
      customerId = verifyBwanaToken(body.token).id;
    } catch {
      // Not reported: /api/spin already reported this token if it was invalid.
      return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
    }

    const { error } = await getSupabase()
      .from('wheel_spin_log')
      .update({ result_seen_at: new Date().toISOString() })
      .eq('day_date', getWheelDayDate())
      .eq('test_bucket', '')
      .eq('customer_id', customerId)
      .is('result_seen_at', null);
    if (error) {
      waitUntil(reportError(error, { route: 'spin-ack', status: 500, code: 'ack_failed', customerId }));
      return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    waitUntil(reportError(err, { route: 'spin-ack', status: 500, code: 'unhandled' }));
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: compiles; `/api/spin-ack` listed in the route table.

- [ ] **Step 3: Commit**

```bash
git add app/api/spin-ack/route.js
git commit -m "feat(api): spin-ack stamps result_seen_at when the result card renders

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Widget fires the ack

**Files:**
- Modify: `components/WheelWidget.jsx`

- [ ] **Step 1: Add the helper** directly after `fetchSpinStatus` (before the `// Best-effort client error reporter` comment):

```js
// Tell the server the result card actually rendered. Fire-and-forget, once
// per page load; keepalive so a tab closing on the card still delivers it.
// Real traffic only — test spins have no BwanaBet token.
let _ackSent = false;
function ackResultShown(token, result) {
  if (_ackSent || !token || !result) return;
  _ackSent = true;
  try {
    fetch('/api/spin-ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ token, won: !result.isLoss, prize: result.prize?.kwacha ?? null }),
    }).catch(() => {});
  } catch { /* never break the result screen */ }
}
```

- [ ] **Step 2: Call it where the card renders.** In the settle `setTimeout` (around `setSpinResult(segment);`), change:

```js
                  const segment = winSegmentRef.current;
                  setScreen('result');
                  setSpinResult(segment);
                  setShowSlowingText(false);
                  if (!isTestMode) ackResultShown(authTokenRef.current, segment);
```

`isTestMode` is already in scope in the component (it is used by `stopWheel`); if the animation effect's dependency array lists its inputs, add `isTestMode` to it.

- [ ] **Step 3: Verify the recovery path is covered.** `landOnRecordedSpin` sets `pendingResultRef`/`winSegmentRef` and the same animation settle block renders the card, so the single call in Step 2 covers both the happy path and recovery. No second call needed.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add components/WheelWidget.jsx
git commit -m "feat(widget): acknowledge the rendered result to /api/spin-ack

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Apply migration, verify live, merge

**Files:** none new.

- [ ] **Step 1: Full test run**

Run: `npm test`
Expected: all passing (telemetry, telegramSend, digestLines, plus every pre-existing suite).

- [ ] **Step 2: Apply the migration to the CRM project** (`blrrcnrhixckfudiojwe`) with the Supabase MCP `apply_migration`, name `loss_reason_result_seen`, query = the file contents **without** the outer `BEGIN;`/`COMMIT;`/`SET LOCAL` lines (the tool wraps its own transaction).

Expected: success. Verify:

```sql
select column_name from information_schema.columns
where table_name='wheel_spin_log' and column_name in ('loss_reason','result_seen_at');
```
Expected: 2 rows.

- [ ] **Step 3: Live RPC check in a test bucket** (`execute_sql`, service role):

```sql
select claim_spin(
  current_date, 'stress', 'plan-verify-' || extract(epoch from now())::bigint::text,
  null, '127.0.0.1', 1, '{}'::jsonb,
  true, null, true, 0, 'queue',
  '[5,5,10]'::jsonb, 0, 'v2'
);
```
Expected: JSON with `"win": false` and `"loss_reason": "cap_reached"` (release cap 0), all previous keys present.

```sql
select loss_reason from wheel_spin_log where test_bucket='stress' order by created_at desc limit 1;
```
Expected: `cap_reached`.

- [ ] **Step 4: Confirm real traffic is unaffected** — wait for ≥ 1 real spin after the migration, then:

```sql
select won, loss_reason, count(*) from wheel_spin_log
where day_date = current_date and test_bucket='' and created_at > now() - interval '10 minutes'
group by 1,2;
```
Expected: losses now carry a reason; wins have NULL. (Real rows get reasons as soon as the migration applies — the old code ignores the new key.)

- [ ] **Step 5: Merge and deploy**

```bash
git checkout main
git merge --no-ff feat/server-telemetry-coverage -m "merge: server-side telemetry coverage, loss reasons, result ack

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 6: Post-deploy check** (≥ 5 minutes after Vercel reports Ready):

```sql
select count(*) filter (where result_seen_at is not null) acked, count(*) total
from wheel_spin_log where day_date = current_date and test_bucket='' and created_at > now() - interval '5 minutes';
```
Expected: `acked` > 0 — the widget is reaching `/api/spin-ack`.

```sql
select code, count(*) from wheel_error_log where created_at > now() - interval '10 minutes' group by 1;
```
Expected: no `ack_failed`, no `unhandled` from `spin-ack`.

- [ ] **Step 7: Update memory** — add a note that `loss_reason` / `result_seen_at` exist and that `wheel_error_log` now carries server signatures (so the next error audit knows the 5-signature baseline is gone).
