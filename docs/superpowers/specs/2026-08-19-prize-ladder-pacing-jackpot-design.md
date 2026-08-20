# Prize ladder rework, hourly payout pacing, and display jackpot

Date: 2026-08-19 (amended same day)
Status: implemented on branch design/prize-ladder-pacing-jackpot

## 0. Amendments (owner review, 2026-08-19)

1. **Wheel-day reset moves 06:00 -> 09:00 CAT** (07:00 UTC). Owned by
   `lib/wheelTime.js`; algorithms/widget/embed day math, the countdown, and the
   digest cron (now `10 7 * * *`) follow. The pacing quota table is rotated so
   wheel-hour 0 opens at the 09:00 traffic peak (25 prizes).
2. **"YOU WON K10,000" is undisplayable, not merely unreachable.** The jackpot
   segment carries `prize: null` and `isLoss: true` (with `isJackpot` driving
   its marquee artwork), so no input can make the widget construct a K10,000
   win screen. A substituted (unrenderable) server index additionally discards
   the payload's win claim and reports `impossible_segment` telemetry.
4. **Pool is 200 wins per day, not 250** (owner correction, 2026-08-20). The
   original spec above set 250; the actual target was always 200. Corrected
   before the ladder ever ran — no 250-prize pool was created in production, so
   nothing was paid out under it. K2,000 over 200 wins makes the average win
   exactly K10 (it was K8 at 250), which is why the K5 share drops from 83% to
   54%: the budget has to go somewhere. The quota table is rescaled to sum to
   200.

5. **`claim_spin` is layout-aware**: `p_layout` defaults to `'legacy'` (the old
   10-segment indices) and the new bundle passes `'v2'` (14 segments). This
   decouples the migration from the frontend deploy: the migration can apply
   while the old production bundle is still live, which is what allows full
   live testing on a Vercel preview before anything merges to main.

## 1. Context

Three changes, driven by production evidence gathered 2026-08-19.

### 1.1 The pot drains in about an hour

`WHEEL_PAYOUT_MODE=queue` pops prizes first-come-first-served with no pacing, so the
day's entire K2,000 is consumed by the earliest spinners.

| Wheel-day | Wins | Time to drain the pot |
| --- | --- | --- |
| 2026-08-17 | 105 | 4h 21m |
| 2026-08-18 | 100 | 1h 18m |
| 2026-08-19 | 100 | 1h 09m |

On 2026-08-19 the gate results across all 2,972 spins were:

| Outcome | Spins |
| --- | --- |
| Eligible (`deposit_found`) | 1,703 |
| — cooldown-blocked | 131 |
| — **fully qualified and winnable** | **1,572** |
| — actually won | 100 |
| Not eligible (`no_deposit`) | 1,266 |
| Gate timeout | 1 |

**1,472 players were deposit-qualified, off cooldown, and lost solely because the pot
was already empty.** Inside the 69-minute live window, 186 spins produced 100 wins;
outside it, roughly 2,800 spins had a structurally impossible 0% win rate.

The eligible pool is large and stable — 1,700–3,000 eligible spins per day, 55–64% of
traffic — so there is no shortage of legitimate players to pay.

### 1.2 Payout integrity was verified, and is sound

Checked against raw production tables before designing:

- 100 win rows, 100 distinct customers; no account won twice; daily dedup held.
- 100 of 100 wins carry a `wheel_deposit_checks` row with `mode='enforce'` and
  `reason='deposit_found'`. Zero wins on `no_deposit`, `timeout`, or `error`.
- Zero wins with a null fingerprint, so every win ran real browser canvas + WebCrypto
  rather than a scripted endpoint hit.

An apparent device-farming signal (100 winners sharing 69 fingerprints) was
investigated and **dismissed**. `lib/fingerprint.js` hashes screen geometry, timezone,
language, `navigator.platform`, and a fixed canvas draw — all identical across a phone
model. One fingerprint carries 355 accounts and exactly 355 spins. Two tests rule out
farming:

- In the win window all spins average 2.19 accounts per fingerprint; winners average
  1.45. Winners are *less* device-concentrated than the population they came from.
- The worst-looking device (6 winners) is six unrelated people: customer IDs spread
  65k–173k, six different IPs, independent histories back to 2026-07-24, and one of the
  six has used three different fingerprints.

No integrity change is in scope. Fingerprint entropy is a known weakness recorded here
for future reference, not a problem this spec fixes.

### 1.3 Requested product changes

Prizes should span K5–K200, there should be more wins weighted toward the small end,
and the wheel should display a K10,000 jackpot that is impossible to land on.

## 2. Goals

1. Prize ladder of K5–K200 totalling exactly K2,000 across 200 wins per day.
2. Wins paced across all 24 wheel-day hours instead of draining in the first hour.
3. A K10,000 jackpot segment on the wheel that cannot be won, guaranteed by several
   independent mechanisms.

## 3. Non-goals

- No change to deposit-eligibility rules. `DEPOSIT_WINDOW_DAYS` stays 7 and
  `SPIN_COOLDOWN_DAYS` stays 3 (owner decision, 2026-08-19).
- No change to the K2,000 daily budget.
- No fingerprint-entropy work.
- No change to dedup, rate limiting, or the killswitch.

## 4. Design

### 4.1 Prize ladder

`lib/algorithms.js` moves to a 200-prize pool totalling exactly K2,000:

| Prize | Count | Subtotal | Share of wins |
| --- | --- | --- | --- |
| K5 | 108 | K540 | 54.0% |
| K10 | 76 | K760 | 38.0% |
| K20 | 10 | K200 | 5.0% |
| K50 | 4 | K200 | 2.0% |
| K100 | 1 | K100 | 0.5% |
| K200 | 1 | K200 | 0.5% |
| **Total** | **200** | **K2,000** | **100%** |

Average win exactly K10.00. Against ~1,572 qualified spins/day this is a ~12.7% win
rate among qualified players, versus 6.4% today.

The top of the ladder is unchanged from the 250 version; the reduction is absorbed
entirely by moving wins from K5 into K10. That is forced arithmetic, not preference:
K2,000 over 200 wins fixes the mean at K10, so an 83% K5 share is only reachable by
concentrating the remaining budget into more large prizes.

The five-algorithm variety mechanism is retained because positions mode is the rollback
path, but **every algorithm must use the same six amounts** `{5,10,20,50,100,200}`. An
algorithm emitting an amount outside that set would be unmappable to a segment and would
raise in `claim_spin`.

### 4.2 Hourly release pacing

A fixed 24-entry quota table shaped to the 7-day average traffic curve
(2026-08-12 → 2026-08-18). Quotas are per wheel-day hour; the wheel day starts at
04:00 UTC = 06:00 CAT.

| Wheel hr | CAT | Quota | Cumulative cap |
| --- | --- | --- | --- |
| 0 | 09 | 20 | 20 |
| 1 | 10 | 20 | 40 |
| 2 | 11 | 20 | 60 |
| 3 | 12 | 15 | 75 |
| 4 | 13 | 12 | 87 |
| 5 | 14 | 14 | 101 |
| 6 | 15 | 9 | 110 |
| 7 | 16 | 9 | 119 |
| 8 | 17 | 10 | 129 |
| 9 | 18 | 8 | 137 |
| 10 | 19 | 6 | 143 |
| 11 | 20 | 5 | 148 |
| 12 | 21 | 5 | 153 |
| 13 | 22 | 5 | 158 |
| 14 | 23 | 4 | 162 |
| 15 | 00 | 2 | 164 |
| 16 | 01 | 2 | 166 |
| 17 | 02 | 1 | 167 |
| 18 | 03 | 1 | 168 |
| 19 | 04 | 1 | 169 |
| 20 | 05 | 1 | 170 |
| 21 | 06 | 6 | 176 |
| 22 | 07 | 10 | 186 |
| 23 | 08 | 14 | 200 |

Quotas sum to exactly 200; the final cumulative cap is exactly the pool size, so the
whole pot is releasable by end of day.

**Rollover is implicit.** The cap is cumulative, so quota unused in an early hour
remains available later — no separate rollover state, no reconciliation job.

**Depletion behaviour.** Once `queue_pos` reaches the current cap, further eligible
spins in that hour lose. This reuses the existing empty-pot path exactly.

New module `lib/releaseCap.js`:

```js
export const HOURLY_QUOTAS = [20,20,20,15,12,14,9,9,10,8,6,5,
                              5,5,4,2,2,1,1,1,1,6,10,14];
export function wheelHour(nowMs)      // 0..23, CAT-based, 09:00 CAT = hour 0
export function releaseCap(nowMs)     // cumulative prizes released by now
```

Pure functions, no clock or DB dependency beyond the injected `nowMs`, matching the
existing `lib/wheelTime.js` and `lib/cooldown.js` style. The CAT offset is applied
manually (+2h) for the reasons documented in `lib/telegram.js` — server tzdata is not
trusted.

The route passes the value as a new `p_release_cap` argument. In `claim_spin` the queue
pop gains one condition:

```sql
WHERE day_date = p_day AND test_bucket = p_bucket
  AND prize_queue IS NOT NULL
  AND queue_pos < LEAST(jsonb_array_length(prize_queue), p_release_cap)
```

Zero rows updated still means "no prize available", so the loss path, the
`forced_loss_ineligible` telemetry, and the cooldown skip all behave as they do today.

`p_release_cap` has SQL default `2147483647`, so omitting the argument reproduces
current unpaced behaviour exactly. This is the pacing rollback lever: the route can stop
sending it, or send the pool size, without a migration.

Test traffic (`p_skip_dedupe`) bypasses pacing by passing the pool size, so load tests
and forced wins are unaffected.

### 4.3 Wheel segments

The wheel goes from 10 to 14 segments, preserving the alternating prize/loss pattern.

| idx | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | K5 | loss | K10 | loss | K20 | loss | K50 | loss | K100 | loss | K200 | loss | **K10,000** | loss |

- Win segments: `{0,2,4,6,8,10}`
- Loss segments: `{1,3,5,7,9,11,13}`
- Jackpot segment: `12` — a member of neither set

Slice widths stay uniform, so the existing SVG geometry driven by
`NUM = WHEEL_SEGMENTS.length` needs no change. A narrow "rare" jackpot slice is
explicitly deferred; it would require non-uniform arc math.

### 4.4 Guarantees that K10,000 cannot be won

Six independent mechanisms. Each one alone is sufficient; all six ship together.

1. **Never generated.** Every `ALGORITHMS` entry contains only `{5,10,20,50,100,200}`,
   so `generatePrizePool` cannot emit 10000.
2. **No forward mapping.** `PRIZE_TO_SEGMENT` has no `10000` key;
   `prizeToSegmentIndex(10000)` throws.
3. **Rejected at the database boundary.** `claim_spin`'s `v_queue_ok` validation
   whitelists `IN (5,10,20,50,100,200)`; a queue containing 10000 is rejected wholesale
   and never adopted.
4. **No SQL branch.** The segment `CASE` has no 10000 arm, so such a prize hits
   `RAISE EXCEPTION 'Unknown prize amount'` rather than yielding a segment.
5. **Unreachable index.** Segment 12 appears in neither the win `CASE` nor
   `ARRAY[1,3,5,7,9,11,13]`, so no path in `claim_spin` can write it to
   `segment_index`.
6. **Runtime guards.** The route rejects `forceWin` values outside the whitelist before
   reaching SQL. The widget treats any segment index outside the known win/loss sets as
   a loss and reports `impossible_segment` telemetry.

**Known limitation, accepted by the owner:** a displayed prize that cannot be won is
deceptive-advertising exposure with the Zambian regulator, and is hard to defend if a
player asks why it never lands. An alternative — genuinely winnable at ~1-in-500,000
funded from a reserve outside the daily budget — was offered and declined on
2026-08-19 in favour of display-only.

### 4.5 Notification copy

`lib/telegram.js` hardcodes `Win #N of 100`. The `100` becomes the actual pool size,
derived from the queue length rather than a literal, so future ladder changes do not
desynchronise the message. The `K2,000` budget literal stays correct and unchanged.

## 5. Migration and rollback

All SQL and JS ship together in one transaction. `claim_spin` hardcodes the prize set in
**three** places; every one must move in the same migration.

| Location | Current | Becomes |
| --- | --- | --- |
| `v_queue_ok` validation | `IN (10,20,50,100,200)` | `IN (5,10,20,50,100,200)` |
| Segment `CASE` | 5 arms → 0,2,4,6,8 | 6 arms → 0,2,4,6,8,10 |
| Carryover guard | `IN (10,20,50,100,200)` | `IN (5,10,20,50,100,200)` |
| Loss segment array | `ARRAY[1,3,5,7,9]` | `ARRAY[1,3,5,7,9,11,13]` |
| Signature | 13 args | 14 args (`p_release_cap`) |

**The `v_queue_ok` list is the dangerous one.** If K5 ships in the queue while the
whitelist still excludes it, validation fails, `prize_queue` stays NULL, and the wheel
pays out nothing for the entire day with no error raised and no alert fired.

JS changes: `lib/algorithms.js` (ladder, `PRIZE_TO_SEGMENT`, `LOSS_SEGMENTS`),
new `lib/releaseCap.js`, `app/api/spin/route.js` (pass `p_release_cap`, whitelist
`forceWin`), `components/WheelWidget.jsx` (`WHEEL_SEGMENTS`, impossible-index guard),
`lib/telegram.js` (pool size).

Follow the `2026-08-12-fcfs-payout-queue.sql` pattern: single `BEGIN/COMMIT`,
`SET LOCAL lock_timeout = '3s'`, drop all prior signatures so exactly one remains,
re-`REVOKE`/`GRANT` so only `service_role` can execute.

**Rollback ladder**, cheapest first:

1. Pacing only: pass a large `p_release_cap` — restores unpaced FCFS, ladder intact.
2. Everything: `WHEEL_PAYOUT_MODE=positions` — env flip, no redeploy. Positions mode
   carries the same six amounts so it remains a valid fallback.

## 6. Testing

- `releaseCap`: quotas sum to 200; cap is monotonic; cap at final hour equals pool size;
  hour boundaries land correctly across the 09:00 CAT day rollover and across UTC
  midnight; unused early quota is still available later.
- Ladder: counts sum to 200 and amounts sum to exactly 2000, asserted per algorithm.
- Jackpot, exhaustive: for every algorithm × every prize in its pool, assert the mapped
  segment is never 12; assert 12 is absent from both segment sets; assert
  `prizeToSegmentIndex(10000)` throws; property-test `generatePrizePool` output against
  the whitelist.
- Route: `forceWin: 10000` is rejected before SQL.
- Widget: a server response carrying segment 12 renders as a loss and fires telemetry.
- SQL: a queue containing an invalid amount is rejected; pop respects the cap; a
  depleted hour returns a loss without consuming a prize; cooldown-blocked spins still
  leave the prize in the queue.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| `v_queue_ok` not updated → silent all-day zero payout | Ship in one migration; test asserts a K5 queue is adopted |
| Traffic curve drifts from the hardcoded table | Cumulative cap self-corrects within the day; table is one constant to re-tune |
| Low-traffic day leaves prizes unreleased | Final-hour cap equals pool size, so the tail drains if anyone spins |
| K5 perceived as too small | 83% of wins are K5; monitor complaint volume and reshape the ladder if needed |
| Regulator/perception risk on unwinnable K10,000 | Flagged and accepted; see §4.4 |
