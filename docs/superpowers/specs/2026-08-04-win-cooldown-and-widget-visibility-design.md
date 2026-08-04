# Win cooldown + widget visibility — design

Date: 2026-08-04
Status: approved for planning

## 1. Context

Two problems, reported together.

**A. "The wheel stopped appearing."** Reported by a team member. Investigation
(§2) found the wheel is healthy system-wide — spins were landing seconds before
the check — so this is a per-user or per-device failure, not an outage. We have
no way to tell which of ~8 possible gates failed for them, because none of them
are observable.

**B. Repeat winners.** A customer who wins should not be able to win again for
3 days. Winnings are credited manually and are indistinguishable from a genuine
customer deposit, so a payout makes the winner look like they deposited "the
previous day" and re-qualifies them for the deposit-eligibility gate the very
next day.

## 2. Investigation findings (2026-08-04)

### 2.1 The wheel is not down

| Check | Result |
| --- | --- |
| `wheel-of-fortune-roan.vercel.app` | 200 |
| `SPIN_MAINTENANCE` | off (spin-status reaches token validation) |
| Deployed `embed.js` vs repo | identical |
| Script tag on `bwanabet.co.zm` / `bwanabet.com` | present |
| CSP / `X-Frame-Options` on host page | none — not blocking |
| Prod `claim_spin` | customer-only dedup (shared devices OK) |
| Last real spin at time of query | 2 seconds prior |

No code has shipped since 2026-07-27.

### 2.2 But engagement is decaying

Spins before 08:30 UTC, by wheel-day:

```
07-25  3,651    07-29  2,163    08-02  2,039
07-26  3,412    07-30  1,999    08-03  1,812
07-27  2,318    07-31  1,960    08-04  1,597
07-28  2,206    08-01  1,998
```

A ~56% decline over ten days. Contributing cause: the deposit gate blocks
**40–57 would-be wins/day** against **14–28 actual wins/day**, and a blocked win
is *burned* — `claim_spin` sets `v_is_win := false` and the prize is never
re-offered. Actual payout is K210–K510/day against a K2,000/day design (~18%).

**Decision: this is intentional and stays unchanged.** The business expects
word-of-mouth from winners to lift spin volume over time. This spec does not
alter deposit-gate behaviour. Recorded here only as context for §2.3.

### 2.3 Repeat winning is already rare

Over 2026-07-24 → 2026-08-04 (all real traffic): **184 distinct winners, 5 won
twice**, shortest gap exactly 3 days. The rule in §4.3 would have blocked 3 of
those 5 — roughly **0–1 blocked wins/day**.

This is a *fairness guarantee* ("nobody wins twice inside 3 days"), not a
mechanism that will visibly widen the winner pool. Expectations are set
accordingly.

### 2.4 Why the wheel can fail to appear

Every gate between page load and a visible trigger button, ranked by likelihood
for the reporting team member:

1. **Already spun today.** One spin per account per wheel-day (06:00 CAT).
   Afterwards `bwanabet_wheel_spun` in localStorage means `initWidget()` is never
   called on subsequent loads — the button is not hidden, it is never built.
   Indistinguishable from a fault.
2. **Ad-blocker / built-in blocker.** The trigger is a fixed-position floating
   div injected by a third-party script; the widget is a `*.vercel.app` iframe.
   uBlock Origin, Brave Shields, AdGuard, Opera and several Android browsers
   block this shape. Nothing detects or recovers from it.
3. **Non-allowlisted host origin.** `WheelWidget.jsx` accepts the auth token only
   from `https://bwanabet.com`, `https://bwanabet.co.zm`, or the dev host. Any
   other origin silently drops the token; `resolveAvailability` never runs, so no
   `bwanabet-wheel-available` is ever posted and the button stays hidden forever.
   Related: `www.bwanabet.co.zm` returns a bare **404** with no redirect to apex.
4. **Device clock skew.** `embed.js` rejects the session via
   `payload.exp * 1000 <= Date.now()`. A device whose clock runs ahead treats a
   valid session as expired — permanently, on that device only.
5. **Logged out, or session on the other domain.** Cookies do not cross
   `bwanabet.com` ↔ `bwanabet.co.zm`.

Plus three genuine bugs:

6. **Transient failures become sticky.** `embed.js` calls `markSpun()` on *any*
   `available:false`. The widget sends that for maintenance mode and for a 401
   `token_expired`, not just a real already-spun verdict. A brief kill-switch
   flip or a mid-session token expiry therefore marks the user as spun for the
   rest of the day, and the wheel will not retry on later page loads.
7. **No timeout on the availability check.** The `/api/spin-status` fetch has no
   timeout and is guarded by a `checked` latch that prevents retry. A *hang*
   (as opposed to an error) means no availability message and no button until a
   full page reload. The existing `.catch()` covers rejection only.
8. **No fallback if the iframe never loads.** `embed.js` waits indefinitely for
   `bwanabet-wheel-ready`. If the iframe is blocked or slow, the button stays
   hidden with no timeout and no telemetry.

## 3. Goals / non-goals

**Goals**
- Make gate failures in §2.4 self-diagnosable in under a minute.
- Stop transient server/auth failures from suppressing the wheel for a whole day.
- Guarantee a customer who wins cannot win again for 3 wheel-days.
- When the cooldown blocks a win, give that prize to another qualifying player.

**Non-goals**
- Changing deposit-gate behaviour, thresholds, or its burned-win semantics.
- Increasing the daily prize budget.
- The prize-credit reconciliation ledger (deferred — §8).
- Any change to wheel animation, segments, or prize algorithms.

## 4. Design

### 4.1 W1 — Diagnostics (ship first)

`embed.js` gains an opt-in debug mode via `window.BWANABET_WHEEL_DEBUG = true`,
logging each gate in order with a `[wheel]` prefix:

```
cookie present → token parsed → exp vs local clock (both printed)
→ customerId → hasSpunToday → widget initialised → iframe created
→ wheel-ready received → auth sent → availability response
```

Printing token expiry *and* local clock side by side makes cause 4 immediately
obvious. Silence after "iframe created" implicates cause 2 or 3. Debug mode is
inert unless the flag is set, so there is no production cost.

Separately, flag to the web team (outside this repo):
- `www.bwanabet.co.zm` → 301 to apex.
- Add `https://www.bwanabet.com` / `https://www.bwanabet.co.zm` to
  `ALLOWED_AUTH_ORIGINS` defensively.

### 4.2 W2 — Stop transient failures becoming sticky

- `/api/spin-status` returns a `reason` field: `already_spun` | `maintenance` |
  `token_expired` | `invalid_token` | `error`.
- The widget posts `{ type: 'bwanabet-wheel-available', available, sticky }`,
  where `sticky` is true **only** for `reason === 'already_spun'`.
- `embed.js` calls `markSpun()` only when `sticky` is true. Every other
  `available:false` hides the button for this page load without writing
  localStorage, so the next page load retries.
- The availability fetch gets a 4s `AbortController` timeout. On timeout the
  widget **fails open** (shows the wheel) — `claim_spin` remains the atomic
  authority and returns `already_spun` if the user really has spun.
- `embed.js` starts an 8s timer when the iframe is created. If
  `bwanabet-wheel-ready` never arrives, it reports `widget_never_ready` to
  `/api/telemetry`. The button stays hidden — showing a button that opens a
  blank overlay is worse than showing nothing — but the failure becomes visible
  in `wheel_error_log` so ad-block/load failures can finally be measured.

### 4.3 W3 — 3-day win cooldown with carry-over

**Rule.** Won on wheel-day D ⇒ cannot win on D+1, D+2, D+3. Winnable again D+4.
Expressed at spin time on day P: blocked if a win exists in `[P-3, P-1]`.

**Placement.** Inside `claim_spin`. It already touches `wheel_spin_log`
atomically and already has a "convert a would-be win into a loss" path, so this
costs **zero extra round trips**.

**Cost control.** The cooldown lookup runs only when the spin already landed on
a winning position (~1 in 100 spins). The normal path is untouched.

```sql
IF v_is_win AND p_eligible AND p_cooldown_days > 0 AND NOT p_skip_dedupe THEN
  SELECT EXISTS (
    SELECT 1 FROM wheel_spin_log
    WHERE customer_id = p_customer AND test_bucket = p_bucket AND won
      AND day_date >= p_day - p_cooldown_days AND day_date < p_day
  ) INTO v_cooldown_blocked;
END IF;
```

**Order of gates.** The deposit gate takes precedence, so that its
burned-win behaviour is preserved exactly:

1. **Deposit gate first.** If `NOT p_eligible`: burn the win, set
   `forced_loss_ineligible`. The prize is **not** banked — an ineligible
   customer's win is destroyed today and must continue to be.
2. **Cooldown second.** Only reached when the spinner *was* eligible. If in
   cooldown: bank the prize on the carry-over queue, set `v_is_win := false`,
   `v_cooldown_blocked := true`.
3. Carry-over award (below).

This ordering matters. Reversing it would let a spinner who is *both* in
cooldown and ineligible bank a prize that today is burned — quietly increasing
payout beyond what was approved. Only prizes intercepted from an otherwise
fully-qualified winner enter the queue.

**Carry-over.** `wheel_daily_state` gains
`carryover_prizes jsonb NOT NULL DEFAULT '[]'::jsonb`, read in the row fetch
`claim_spin` already performs. A prize is awarded when **all** hold:

- the queue is non-empty, and
- this spin did *not* land on a winning position, and
- the spinner passed the deposit gate (`p_eligible`), and
- the spinner is not themselves in cooldown.

The recipient's cooldown lookup only runs when the queue is non-empty — near
always empty, so there is no steady-state cost.

The pop is atomic, locking the state row only when the queue is non-empty:

```sql
WITH popped AS (
  SELECT carryover_prizes->>0 AS prize
  FROM wheel_daily_state
  WHERE day_date = p_day AND test_bucket = p_bucket
    AND jsonb_array_length(carryover_prizes) > 0
  FOR UPDATE
)
UPDATE wheel_daily_state s
   SET carryover_prizes = s.carryover_prizes - 0
  FROM popped
 WHERE s.day_date = p_day AND s.test_bucket = p_bucket
RETURNING popped.prize;
```

An awarded carry-over is a normal win: it increments `total_wins` /
`total_budget_spent`, maps to a segment, notifies Telegram, and starts the
recipient's own 3-day cooldown.

**Budget safety.** Carry-over can only ever re-issue prizes the cooldown itself
intercepted, so delivered wins can never exceed the 100/day the algorithm
already budgets. This is not new spend.

**Leftovers.** Anything still queued at day end is lost. Acceptable — those
prizes would have been burned outright under the current behaviour.

**Tunability.** `p_cooldown_days integer DEFAULT 3`, supplied by the route from
`SPIN_COOLDOWN_DAYS`. Changing the window needs no migration. Setting it to 0
disables the rule (and therefore carry-over) as a kill-switch.

**Test traffic.** Excluded via `p_skip_dedupe`; lookups are scoped by
`test_bucket` so load tests cannot interact with real cooldowns.

## 5. Data model changes

| Table | Change | Why |
| --- | --- | --- |
| `wheel_daily_state` | `+ carryover_prizes jsonb NOT NULL DEFAULT '[]'` | Cooldown-blocked prizes awaiting a recipient |
| `wheel_spin_log` | `+ cooldown_blocked boolean NOT NULL DEFAULT false` | A blocked win is otherwise indistinguishable from an ordinary loss |
| `wheel_spin_log` | `+ carryover_awarded boolean NOT NULL DEFAULT false` | Confirms prizes are reaching other players |
| `wheel_spin_log` | `+ partial index (customer_id, day_date) WHERE won` | Backs the cooldown lookup; tiny (~180 winners/12 days) |

`claim_spin` returns two new fields: `forced_loss_cooldown`, `carryover_awarded`.

**Migration safety.** This is the shared CRM/wheel production database. The index
is built `CREATE INDEX CONCURRENTLY` **outside** any transaction; the `DROP` +
`CREATE` of `claim_spin` stays wrapped in a single transaction so other sessions
never observe a window where the function is missing (which would be a wheel
outage). The two steps are applied as separate statement batches, index first.

## 6. Telemetry and verification

- Daily digest (`/api/digest`) reports cooldown blocks and carry-over awards.
- Success criteria after one week:
  - zero customers with two wins less than 4 wheel-days apart;
  - `carryover_awarded` count ≈ `cooldown_blocked` count (queue is draining);
  - spin latency p95 unchanged (the lookup should be invisible);
  - `widget_never_ready` gives a first real measurement of load/ad-block failure.

## 7. Testing

- Cooldown window arithmetic extracted into a pure helper covered by the
  existing `node --test lib/*.test.mjs` suite: boundary cases at D+1, D+3, D+4,
  and the 06:00 CAT day rollover.
- `sticky` logic in the widget/embed handshake unit-tested per `reason` value.
- SQL verified against a dedicated `test_bucket` with a handful of rows,
  covering: win → blocked next day, blocked prize queued, next qualifying
  spinner receives it, an ineligible spinner does not, and two concurrent
  spinners cannot claim the same queued prize.
- **No load testing against the production database** — see the 2026-07-13
  incident. Row counts here are in the tens.

## 8. Deferred — prize-credit reconciliation ledger

Manual payouts are indistinguishable from customer deposits, so `op_type`
filtering is impossible. The cooldown closes the common case: a prize credited
on day D only creates false eligibility on D+1, which is already blocked.

The loophole survives only if a payout is credited **3 or more days late**. If
that is observed, build: mark each win in `wheel_spin_log` unreconciled; during
the deposit check ignore the first `IN-*` deposit whose `amount` matches an
unreconciled prize for that customer after the win date, then mark it
reconciled. The history API does return `amount` (e.g. `"5.00"`). The DB read
would run in parallel with the BwanaBet API call so latency is `max()`, not the
sum.

**Trigger to build it:** a customer passing the deposit gate on D+4 or later
with no genuine deposit in the qualifying window.

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Cooldown lookup slows the hot path | Runs only on winning positions (~1%); backed by a partial index |
| Carry-over pop causes lock contention | Row lock taken only when the queue is non-empty — near always empty |
| Migration causes a wheel outage on the shared DB | Index built `CONCURRENTLY` outside a transaction; function swap atomic in one transaction |
| Carry-over inflates payout | Bounded above by prizes the cooldown intercepted; total wins still capped at 100/day |
| Failing open on availability timeout allows a double spin | It cannot — `claim_spin` is the atomic authority and returns `already_spun` |
| Expectation that the cooldown widens the winner pool | Documented in §2.3: ~0–1 blocked wins/day |
