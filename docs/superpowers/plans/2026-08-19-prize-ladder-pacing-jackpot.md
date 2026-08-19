# Prize Ladder, Payout Pacing & Display Jackpot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a 250-win K5–K200 prize ladder totalling exactly K2,000/day, paced across all 24 wheel-day hours, with an unwinnable K10,000 jackpot segment on the wheel — live for the 06:00 CAT launch on 2026-08-20.

**Architecture:** Segment index constants live in a new client-safe `lib/wheelSegments.js`; prize amounts and the prize→segment mapping stay server-side in `lib/algorithms.js`, which re-exports the constants for server callers. Pacing is a new pure module `lib/releaseCap.js` holding a fixed 24-entry hourly quota table; the route computes a cumulative cap and passes it to `claim_spin` as a new `p_release_cap` argument, which gates the queue pop. The wheel grows from 10 to 14 segments; the jackpot sits at index 12, a member of neither the win nor loss index set, so no server path can emit it.

**Tech Stack:** Next.js 14 App Router, Supabase Postgres (plpgsql RPC), `node --test` with `node:assert/strict`. Run all tests with `npm test`.

**Spec:** `docs/superpowers/specs/2026-08-19-prize-ladder-pacing-jackpot-design.md`

---

## Context an engineer needs before starting

**The wheel day starts at 06:00 CAT = 04:00 UTC.** Server timezone data is not trusted anywhere in this codebase; CAT is applied as a manual +2h offset. `lib/wheelTime.js` already owns this — `currentWheelDayStartUtc(nowMs)` is the single source of truth. Reuse it; do not recompute day boundaries.

**Today's pot is already exhausted** (`queue_pos = 100` of `queue_len = 100`, 0 carryover). No prize can be paid until a new day row is created at 04:00 UTC. That is why this can ship mid-day safely.

**`claim_spin` hardcodes the valid prize set in three separate places.** The most dangerous is `v_queue_ok`: if a K5-containing queue is submitted while that whitelist still excludes 5, validation fails, `prize_queue` stays NULL, and **the wheel pays out nothing for the entire day with no error raised and no alert fired.** Task 6 changes all three together.

**Segment indices are renumbered.** Old: K10→0, K50→2, K200→4, K20→6, K100→8. New: K5→0, K10→2, K20→4, K50→6, K100→8, K200→10. A browser holding a stale JS bundle across the launch would render the wrong prize label, or crash on an out-of-range index. Task 5 makes the widget read the prize amount from the server payload instead of from the segment table, and bounds-guard the index. Task 8's deploy order (Vercel first, SQL second) closes the rest of the window.

---

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `lib/wheelSegments.js` | Create | Segment index constants ONLY — safe to bundle client-side |
| `lib/algorithms.js` | Modify | Prize ladders and prize→segment mapping (server-only) |
| `lib/algorithms.test.mjs` | Modify | Ladder invariants (250 wins / K2,000 per algorithm) |
| `lib/releaseCap.js` | Create | Hourly quota table, `wheelHour`, `releaseCap` — pure |
| `lib/releaseCap.test.mjs` | Create | Pacing maths, rollover, day-boundary behaviour |
| `lib/landingSegment.js` | Create | Pure guard resolving a server segment index to a safe renderable index |
| `lib/landingSegment.test.mjs` | Create | Guard behaviour incl. jackpot rejection |
| `lib/jackpotSafety.test.mjs` | Create | Auditable proof K10,000 is unreachable — all six guarantees |
| `lib/telegram.js` | Modify | Pool size in the win message instead of literal `100` |
| `lib/telegram.test.mjs` | Modify | Message format assertions |
| `app/api/spin/route.js` | Modify | Pass `p_release_cap`; whitelist `forceWin` |
| `components/WheelWidget.jsx` | Modify | 14 segments; prize from payload; index guard |
| `supabase/migrations/2026-08-19-prize-ladder-pacing-jackpot.sql` | Create | New `claim_spin` (14 args) |

---

## Task 1: Prize ladders and segment constants

**Files:**
- Create: `lib/wheelSegments.js`
- Modify: `lib/algorithms.js:6-12` (ALGORITHMS), `:47-53` (generateWinningPositions), `:64-77` (PRIZE_TO_SEGMENT / LOSS_SEGMENTS)
- Test: `lib/algorithms.test.mjs`

- [ ] **Step 1: Write the failing test**

Replace the whole contents of `lib/algorithms.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALGORITHMS, generatePrizePool, generateWinningPositions, buildWinningMap,
  POOL_SIZE, DAILY_BUDGET, VALID_PRIZE_AMOUNTS,
} from './algorithms.js';

test('pool size is 250 and budget is K2,000', () => {
  assert.equal(POOL_SIZE, 250);
  assert.equal(DAILY_BUDGET, 2000);
});

test('valid amounts are exactly K5..K200', () => {
  assert.deepEqual(VALID_PRIZE_AMOUNTS, [5, 10, 20, 50, 100, 200]);
});

for (const [id, algo] of Object.entries(ALGORITHMS)) {
  test(`algorithm ${id} (${algo.name}): 250 prizes summing to K2,000`, () => {
    const pool = generatePrizePool(Number(id));
    assert.equal(pool.length, POOL_SIZE);
    assert.equal(pool.reduce((a, b) => a + b, 0), DAILY_BUDGET);
  });

  test(`algorithm ${id} (${algo.name}): only valid amounts`, () => {
    for (const p of generatePrizePool(Number(id))) {
      assert.ok(VALID_PRIZE_AMOUNTS.includes(p), `unexpected amount ${p}`);
    }
  });

  test(`algorithm ${id} (${algo.name}): shuffle preserves the multiset`, () => {
    const pool = generatePrizePool(Number(id));
    const counts = {};
    for (const p of pool) counts[p] = (counts[p] || 0) + 1;
    assert.deepEqual(counts, Object.fromEntries(
      Object.entries(algo.prizes).map(([amount, count]) => [amount, count])
    ));
  });
}

test('winning positions match the pool size', () => {
  assert.equal(generateWinningPositions(POOL_SIZE).length, POOL_SIZE);
  assert.equal(Object.keys(buildWinningMap(1)).length, POOL_SIZE);
});

test('unknown algorithm id throws', () => {
  assert.throws(() => generatePrizePool(99), /Unknown algorithm/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `POOL_SIZE` etc. are not exported, and pools contain 100 prizes not 250.

- [ ] **Step 3: Write minimal implementation**

In `lib/algorithms.js`, replace the `ALGORITHMS` block (lines 6-12) with:

```js
// Every ladder: exactly 250 wins totalling exactly K2,000, weighted to the
// small end. Amounts are restricted to VALID_PRIZE_AMOUNTS — claim_spin maps
// prize amount to wheel segment and RAISEs on anything outside that set.
export const POOL_SIZE = 250;
export const DAILY_BUDGET = 2000;
export const VALID_PRIZE_AMOUNTS = [5, 10, 20, 50, 100, 200];

export const ALGORITHMS = {
  1: { name: 'Drizzle',   prizes: { 5: 208, 10: 26, 20: 10, 50: 4, 100: 1, 200: 1 } },
  2: { name: 'Balanced',  prizes: { 5: 214, 10: 22, 20: 8,  50: 3, 100: 2, 200: 1 } },
  3: { name: 'K50-heavy', prizes: { 5: 228, 10: 8,  20: 4,  50: 8, 100: 1, 200: 1 } },
  4: { name: 'Top-heavy', prizes: { 5: 234, 10: 7,  20: 3,  50: 2, 100: 2, 200: 2 } },
  5: { name: 'K20-heavy', prizes: { 5: 212, 10: 14, 20: 20, 50: 2, 100: 1, 200: 1 } },
};
```

Change `generateWinningPositions` (lines 47-53) to take a count:

```js
export function generateWinningPositions(count = POOL_SIZE) {
  const positions = new Set();
  while (positions.size < count) {
    positions.add(Math.floor(Math.random() * WINNABLE_POSITIONS) + 1);
  }
  return Array.from(positions).sort((a, b) => a - b);
}
```

Change `buildWinningMap` to pass the pool length:

```js
export function buildWinningMap(algorithmId) {
  const prizes = generatePrizePool(algorithmId);
  const positions = generateWinningPositions(prizes.length);
  const map = {};
  positions.forEach((pos, i) => {
    map[String(pos)] = prizes[i];
  });
  return map;
}
```

Create `lib/wheelSegments.js` — index constants only. **This module must never
import or re-export prize amounts:** the widget imports it, so anything in here
ships to the browser, and the daily prize ladder must stay server-side.

```js
// Wheel segment index constants. Deliberately free of prize amounts so the
// client bundle can import it without exposing the day's prize distribution.
//
// 14 segments: even indices 0..10 are the six real prizes in ascending order,
// index 12 is the DISPLAY-ONLY K10,000 jackpot, odd indices are losses.
// Index 12 is in neither reachable set, so no server path can select it.
export const SEGMENT_COUNT = 14;
export const JACKPOT_SEGMENT_INDEX = 12;
export const WIN_SEGMENTS = [0, 2, 4, 6, 8, 10];
export const LOSS_SEGMENTS = [1, 3, 5, 7, 9, 11, 13];
```

Then replace the segment block in `lib/algorithms.js` (lines 64-77) with:

```js
import { WIN_SEGMENTS, LOSS_SEGMENTS } from './wheelSegments.js';
export { SEGMENT_COUNT, JACKPOT_SEGMENT_INDEX, WIN_SEGMENTS, LOSS_SEGMENTS } from './wheelSegments.js';

const PRIZE_TO_SEGMENT = {
  5: 0,
  10: 2,
  20: 4,
  50: 6,
  100: 8,
  200: 10,
};

export function prizeToSegmentIndex(prizeAmount) {
  const idx = PRIZE_TO_SEGMENT[prizeAmount];
  if (idx === undefined) throw new Error(`Unknown prize amount: ${prizeAmount}`);
  return idx;
}

// The mapping and the shared constant must not drift apart.
if (Object.values(PRIZE_TO_SEGMENT).sort((a, b) => a - b).join() !== WIN_SEGMENTS.join()) {
  throw new Error('PRIZE_TO_SEGMENT does not match WIN_SEGMENTS');
}

export function pickLossSegment() {
  return LOSS_SEGMENTS[Math.floor(Math.random() * LOSS_SEGMENTS.length)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all algorithm tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/wheelSegments.js lib/algorithms.js lib/algorithms.test.mjs
git commit -m "feat(algorithms): 250-win K5-K200 ladder and 14-segment layout"
```

---

## Task 2: Jackpot safety proof

**Files:**
- Create: `lib/jackpotSafety.test.mjs`

This test file exists to make the "K10,000 cannot be won" guarantee auditable in one place. It must never be deleted.

- [ ] **Step 1: Write the failing test**

Create `lib/jackpotSafety.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALGORITHMS, generatePrizePool, prizeToSegmentIndex,
  WIN_SEGMENTS, LOSS_SEGMENTS, JACKPOT_SEGMENT_INDEX, SEGMENT_COUNT,
  VALID_PRIZE_AMOUNTS,
} from './algorithms.js';

const JACKPOT_AMOUNT = 10000;

// Guarantee 1: the jackpot amount can never be generated into a prize pool.
test('no algorithm can emit K10,000', () => {
  for (const id of Object.keys(ALGORITHMS)) {
    assert.ok(!Object.keys(ALGORITHMS[id].prizes).includes(String(JACKPOT_AMOUNT)));
    for (const p of generatePrizePool(Number(id))) {
      assert.notEqual(p, JACKPOT_AMOUNT);
    }
  }
});

// Guarantee 2: there is no forward mapping from the jackpot amount.
test('prizeToSegmentIndex(10000) throws', () => {
  assert.throws(() => prizeToSegmentIndex(JACKPOT_AMOUNT), /Unknown prize amount/);
});

test('K10,000 is not a valid prize amount', () => {
  assert.ok(!VALID_PRIZE_AMOUNTS.includes(JACKPOT_AMOUNT));
});

// Guarantee 5: the jackpot index belongs to neither reachable set.
test('jackpot index is in neither the win nor the loss set', () => {
  assert.ok(!WIN_SEGMENTS.includes(JACKPOT_SEGMENT_INDEX));
  assert.ok(!LOSS_SEGMENTS.includes(JACKPOT_SEGMENT_INDEX));
});

test('win and loss sets together cover every segment except the jackpot', () => {
  const reachable = [...WIN_SEGMENTS, ...LOSS_SEGMENTS].sort((a, b) => a - b);
  const expected = Array.from({ length: SEGMENT_COUNT }, (_, i) => i)
    .filter(i => i !== JACKPOT_SEGMENT_INDEX);
  assert.deepEqual(reachable, expected);
});

test('win and loss sets do not overlap', () => {
  assert.equal(WIN_SEGMENTS.filter(i => LOSS_SEGMENTS.includes(i)).length, 0);
});

// Exhaustive: every prize of every algorithm maps somewhere that is not the jackpot.
test('exhaustive: no prize in any algorithm maps to the jackpot segment', () => {
  for (const id of Object.keys(ALGORITHMS)) {
    for (const amount of Object.keys(ALGORITHMS[id].prizes)) {
      const seg = prizeToSegmentIndex(Number(amount));
      assert.notEqual(seg, JACKPOT_SEGMENT_INDEX);
      assert.ok(seg >= 0 && seg < SEGMENT_COUNT);
    }
  }
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test`
Expected: PASS (Task 1 already provides the exports). If any test fails, Task 1 is wrong — fix Task 1, do not weaken this file.

- [ ] **Step 3: Commit**

```bash
git add lib/jackpotSafety.test.mjs
git commit -m "test(jackpot): auditable proof K10,000 is unreachable"
```

---

## Task 3: Hourly release pacing

**Files:**
- Create: `lib/releaseCap.js`, `lib/releaseCap.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `lib/releaseCap.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOURLY_QUOTAS, wheelHour, releaseCap, UNPACED_CAP } from './releaseCap.js';
import { POOL_SIZE } from './algorithms.js';

// 04:00 UTC == 06:00 CAT == wheel hour 0.
const at = (iso) => Date.parse(iso);

test('quota table has 24 entries summing to the pool size', () => {
  assert.equal(HOURLY_QUOTAS.length, 24);
  assert.equal(HOURLY_QUOTAS.reduce((a, b) => a + b, 0), POOL_SIZE);
});

test('wheel hour 0 starts at 04:00 UTC', () => {
  assert.equal(wheelHour(at('2026-08-20T04:00:00Z')), 0);
  assert.equal(wheelHour(at('2026-08-20T04:59:59Z')), 0);
  assert.equal(wheelHour(at('2026-08-20T05:00:00Z')), 1);
});

test('wheel hour rolls through UTC midnight to 23', () => {
  assert.equal(wheelHour(at('2026-08-20T23:30:00Z')), 19);
  assert.equal(wheelHour(at('2026-08-21T00:30:00Z')), 20);
  assert.equal(wheelHour(at('2026-08-21T03:59:59Z')), 23);
});

test('just before the reset is still hour 23 of the previous wheel-day', () => {
  assert.equal(wheelHour(at('2026-08-21T03:00:00Z')), 23);
});

test('cap at hour 0 is the first quota', () => {
  assert.equal(releaseCap(at('2026-08-20T04:30:00Z')), HOURLY_QUOTAS[0]);
});

test('cap is cumulative — unused early quota stays available', () => {
  assert.equal(
    releaseCap(at('2026-08-20T06:30:00Z')),
    HOURLY_QUOTAS[0] + HOURLY_QUOTAS[1] + HOURLY_QUOTAS[2],
  );
});

test('cap is monotonically non-decreasing across the day', () => {
  let prev = 0;
  for (let h = 0; h < 24; h++) {
    const cap = releaseCap(at('2026-08-20T04:00:00Z') + h * 3600_000);
    assert.ok(cap >= prev, `cap fell at hour ${h}`);
    prev = cap;
  }
});

test('final hour releases the entire pool', () => {
  assert.equal(releaseCap(at('2026-08-21T03:30:00Z')), POOL_SIZE);
});

test('UNPACED_CAP disables pacing', () => {
  assert.ok(UNPACED_CAP > POOL_SIZE);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './releaseCap.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/releaseCap.js`:

```js
// Hourly payout pacing.
//
// The FCFS queue used to drain the whole day's K2,000 in about 70 minutes,
// leaving ~1,470 deposit-qualified players per day with a structurally
// impossible 0% win rate. This module spreads the pool across all 24
// wheel-day hours, shaped to the observed traffic curve so the win rate is
// roughly flat around the clock.
//
// The cap is CUMULATIVE, which is what gives rollover for free: quota unused
// in a quiet hour is still available later in the day. When queue_pos catches
// up to the cap, further eligible spins simply lose — the same code path as
// an empty pot.

import { currentWheelDayStartUtc } from './wheelTime.js';
import { POOL_SIZE } from './algorithms.js';

// Index = wheel-day hour (0 == 06:00 CAT). Shaped to the 7-day average spin
// distribution measured 2026-08-12..2026-08-18. Sums to exactly POOL_SIZE.
export const HOURLY_QUOTAS = [
  8, 12, 18, 25, 25, 26, 19, 15, 17, 11, 11, 13,
  10, 8, 6, 6, 6, 5, 3, 2, 1, 1, 1, 1,
];

// Sentinel meaning "no pacing" — used for test traffic and as the rollback
// value. Matches the SQL default so the argument can simply be omitted.
export const UNPACED_CAP = 2147483647;

const HOUR_MS = 60 * 60 * 1000;

// Hours elapsed since the current wheel-day started, clamped to 0..23.
export function wheelHour(nowMs) {
  const elapsed = nowMs - currentWheelDayStartUtc(nowMs);
  return Math.min(23, Math.max(0, Math.floor(elapsed / HOUR_MS)));
}

// How many prizes may have been released in total by `nowMs`.
export function releaseCap(nowMs, quotas = HOURLY_QUOTAS) {
  const h = wheelHour(nowMs);
  let cap = 0;
  for (let i = 0; i <= h; i++) cap += quotas[i];
  return cap;
}

// Guard: a mis-edited table would silently mis-pace the day.
if (HOURLY_QUOTAS.reduce((a, b) => a + b, 0) !== POOL_SIZE) {
  throw new Error('HOURLY_QUOTAS must sum to POOL_SIZE');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/releaseCap.js lib/releaseCap.test.mjs
git commit -m "feat(pacing): hourly release cap with cumulative rollover"
```

---

## Task 4: Landing-segment guard

**Files:**
- Create: `lib/landingSegment.js`, `lib/landingSegment.test.mjs`

Defence in depth for the widget: if the server ever sends an index the client cannot render (jackpot, out of range, wrong-version bundle), land somewhere safe rather than crashing.

- [ ] **Step 1: Write the failing test**

Create `lib/landingSegment.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLandingSegment } from './landingSegment.js';
import { WIN_SEGMENTS, LOSS_SEGMENTS, JACKPOT_SEGMENT_INDEX } from './wheelSegments.js';

const alwaysZero = () => 0;

test('a valid win index passes through unchanged', () => {
  for (const i of WIN_SEGMENTS) {
    assert.equal(resolveLandingSegment(i, alwaysZero).index, i);
    assert.equal(resolveLandingSegment(i, alwaysZero).substituted, false);
  }
});

test('a valid loss index passes through unchanged', () => {
  for (const i of LOSS_SEGMENTS) {
    assert.equal(resolveLandingSegment(i, alwaysZero).index, i);
  }
});

test('the jackpot index is never rendered', () => {
  const r = resolveLandingSegment(JACKPOT_SEGMENT_INDEX, alwaysZero);
  assert.notEqual(r.index, JACKPOT_SEGMENT_INDEX);
  assert.ok(LOSS_SEGMENTS.includes(r.index));
  assert.equal(r.substituted, true);
});

test('out-of-range indices fall back to a loss segment', () => {
  for (const bad of [-1, 14, 99, 2.5, NaN, null, undefined, '4']) {
    const r = resolveLandingSegment(bad, alwaysZero);
    assert.ok(LOSS_SEGMENTS.includes(r.index), `bad input ${bad} -> ${r.index}`);
    assert.equal(r.substituted, true);
  }
});

test('substitution uses the injected rng across the loss set', () => {
  assert.equal(resolveLandingSegment(99, () => 0).index, LOSS_SEGMENTS[0]);
  assert.equal(
    resolveLandingSegment(99, () => 0.999).index,
    LOSS_SEGMENTS[LOSS_SEGMENTS.length - 1],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './landingSegment.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/landingSegment.js`:

```js
// Where the wheel should visually stop, given the server's segment index.
//
// The server is the authority on win/loss and prize amount; this only decides
// which slice the pointer rests on. Anything unrenderable — the display-only
// jackpot, an out-of-range index, or an index from a mismatched bundle
// version — is substituted with a loss slice so the widget never crashes and
// never shows the jackpot as a landing.

// Imports from wheelSegments.js, NOT algorithms.js — this module is pulled
// into the client bundle by WheelWidget, and algorithms.js carries the day's
// prize distribution, which must never reach the browser.
import { WIN_SEGMENTS, LOSS_SEGMENTS } from './wheelSegments.js';

const RENDERABLE = new Set([...WIN_SEGMENTS, ...LOSS_SEGMENTS]);

export function resolveLandingSegment(segmentIndex, rng = Math.random) {
  if (Number.isInteger(segmentIndex) && RENDERABLE.has(segmentIndex)) {
    return { index: segmentIndex, substituted: false };
  }
  const i = Math.min(LOSS_SEGMENTS.length - 1, Math.floor(rng() * LOSS_SEGMENTS.length));
  return { index: LOSS_SEGMENTS[i], substituted: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/landingSegment.js lib/landingSegment.test.mjs
git commit -m "feat(widget): guard against unrenderable segment indices"
```

---

## Task 5: Widget — 14 segments, payload-driven prize

**Files:**
- Modify: `components/WheelWidget.jsx:13-26` (WHEEL_SEGMENTS), `:661`, `:755`, `:807-810`, `:620-637`

- [ ] **Step 1: Replace the segment table**

Replace lines 13-26 of `components/WheelWidget.jsx`:

```jsx
// DATA — 14 segments: six real prizes on even indices 0..10 in ascending
// order, the DISPLAY-ONLY K10,000 jackpot at index 12, losses on odds.
// Index 12 is unreachable: the server maps prizes only to 0,2,4,6,8,10 and
// losses only to odd indices. See lib/jackpotSafety.test.mjs.
const WHEEL_SEGMENTS = [
  { id: 1,  label: 'K5',                 prize: { kwacha: 5 },   color: '#00e5ff', isLoss: false },
  { id: 2,  label: 'Try Again Tomorrow', prize: null,            color: '#78909c', isLoss: true },
  { id: 3,  label: 'K10',                prize: { kwacha: 10 },  color: '#00e676', isLoss: false },
  { id: 4,  label: 'Try Again Tomorrow', prize: null,            color: '#78909c', isLoss: true },
  { id: 5,  label: 'K20',                prize: { kwacha: 20 },  color: '#d500f9', isLoss: false },
  { id: 6,  label: 'Try Again Tomorrow', prize: null,            color: '#78909c', isLoss: true },
  { id: 7,  label: 'K50',                prize: { kwacha: 50 },  color: '#ff6d00', isLoss: false },
  { id: 8,  label: 'Try Again Tomorrow', prize: null,            color: '#78909c', isLoss: true },
  { id: 9,  label: 'K100',               prize: { kwacha: 100 }, color: '#ffd600', isLoss: false },
  { id: 10, label: 'Try Again Tomorrow', prize: null,            color: '#78909c', isLoss: true },
  { id: 11, label: 'K200',               prize: { kwacha: 200 }, color: '#ff1744', isLoss: false },
  { id: 12, label: 'Try Again Tomorrow', prize: null,            color: '#78909c', isLoss: true },
  { id: 13, label: 'K10,000',            prize: { kwacha: 10000 }, color: '#ffea00', isLoss: false },
  { id: 14, label: 'Try Again Tomorrow', prize: null,            color: '#78909c', isLoss: true },
];
```

- [ ] **Step 2: Import the guard**

Add to the import block at the top of the file:

```jsx
import { resolveLandingSegment } from '@/lib/landingSegment';
```

- [ ] **Step 3: Make the landing use the guard and the prize come from the payload**

At line 661, replace:

```jsx
winSegmentRef.current = WHEEL_SEGMENTS[winIndex];
```

with:

```jsx
// The server is the authority on the prize amount; the segment table only
// supplies the slice we stop on. Reading kwacha from the payload keeps the
// displayed amount correct even if a stale bundle has a different layout.
const landing = resolveLandingSegment(winIndex);
const base = WHEEL_SEGMENTS[landing.index];
winSegmentRef.current = data && data.win
  ? { ...base, isLoss: false, prize: { kwacha: data.prize?.kwacha ?? base.prize?.kwacha ?? 0 } }
  : { ...base, isLoss: true, prize: null };
```

Then, in the same block, the target angle must use `landing.index`, not `winIndex`:

```jsx
const segCenter = landing.index * SEG_ANGLE + SEG_ANGLE / 2;
```

- [ ] **Step 4: Apply the same guard on the recovery path**

At line 755, replace:

```jsx
winSegmentRef.current = WHEEL_SEGMENTS[rec.segmentIndex];
```

with:

```jsx
const recLanding = resolveLandingSegment(rec.segmentIndex);
const recBase = WHEEL_SEGMENTS[recLanding.index];
winSegmentRef.current = rec.won
  ? { ...recBase, isLoss: false, prize: { kwacha: rec.prizeAmount ?? recBase.prize?.kwacha ?? 0 } }
  : { ...recBase, isLoss: true, prize: null };
```

- [ ] **Step 5: Update the error-path loss fallback**

At lines 807-810, replace the hardcoded loss lookup with the shared constant so it stays in sync:

```jsx
const fallback = resolveLandingSegment(-1); // always substitutes a loss slice
pendingResultRef.current = {
  winIndex: fallback.index,
  data: { segmentIndex: fallback.index, won: false, prize: 0 },
};
winSegmentRef.current = { ...WHEEL_SEGMENTS[fallback.index], isLoss: true, prize: null };
```

- [ ] **Step 6: Verify the build compiles**

Run: `npm run build`
Expected: compiles with no errors.

- [ ] **Step 7: Commit**

```bash
git add components/WheelWidget.jsx
git commit -m "feat(widget): 14 segments with K10,000 jackpot, payload-driven prize"
```

---

## Task 6: Database migration

**Files:**
- Create: `supabase/migrations/2026-08-19-prize-ladder-pacing-jackpot.sql`

Base this on `supabase/migrations/2026-08-12-fcfs-payout-queue.sql` — copy that file and apply the five changes below. Do not rewrite it from scratch; all other behaviour (dedupe, cooldown, carryover, day-init, advisory lock ordering) must be preserved byte-for-byte.

- [ ] **Step 1: Copy the baseline**

```bash
cp supabase/migrations/2026-08-12-fcfs-payout-queue.sql \
   supabase/migrations/2026-08-19-prize-ladder-pacing-jackpot.sql
```

- [ ] **Step 2: Add the new argument to the signature**

Add as the final parameter of `CREATE OR REPLACE FUNCTION public.claim_spin(...)`:

```sql
  p_release_cap integer DEFAULT 2147483647
```

And change the `DROP FUNCTION` block so the previous 13-arg signature is removed:

```sql
DROP FUNCTION IF EXISTS public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer, text, jsonb);
```

- [ ] **Step 3: Widen the three hardcoded prize whitelists**

`v_queue_ok` validation — change:

```sql
         OR NOT (e::text)::numeric IN (10, 20, 50, 100, 200)
```
to:
```sql
         OR NOT (e::text)::numeric IN (5, 10, 20, 50, 100, 200)
```

Carryover guard — change `IF v_prize IN (10, 20, 50, 100, 200) THEN` to:

```sql
      IF v_prize IN (5, 10, 20, 50, 100, 200) THEN
```

Segment mapping — replace the `CASE` with:

```sql
    v_segment := CASE v_prize
      WHEN 5 THEN 0 WHEN 10 THEN 2 WHEN 20 THEN 4
      WHEN 50 THEN 6 WHEN 100 THEN 8 WHEN 200 THEN 10
      ELSE NULL END;
```

Loss segments — replace `(ARRAY[1, 3, 5, 7, 9])[1 + (floor(random() * 5))::int]` with:

```sql
    v_segment := (ARRAY[1, 3, 5, 7, 9, 11, 13])[1 + (floor(random() * 7))::int];
```

- [ ] **Step 4: Gate the queue pop on the release cap**

In the queue-mode `UPDATE ... SET queue_pos = queue_pos + 1`, change the guard:

```sql
        WHERE day_date = p_day AND test_bucket = p_bucket
          AND prize_queue IS NOT NULL
          AND queue_pos < LEAST(jsonb_array_length(prize_queue), p_release_cap)
```

And in the ineligible-telemetry select just above it, apply the same cap so a spin that would have lost to pacing is not misreported as gate-blocked:

```sql
      SELECT (prize_queue IS NOT NULL
              AND queue_pos < LEAST(jsonb_array_length(prize_queue), p_release_cap))
      INTO v_forced_ineligible
```

- [ ] **Step 5: Update the grants to the new 14-arg signature**

Replace all three `REVOKE`/`GRANT` lines, appending `, integer` to the argument list:

```sql
REVOKE ALL ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer, text, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer, text, jsonb, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_spin(date, text, text, text, text, integer, jsonb, boolean, integer, boolean, integer, text, jsonb, integer) TO service_role;
```

- [ ] **Step 6: Update the header comment**

Replace the file's leading comment block date/spec lines with:

```sql
-- Wheel of Fortune — 250-win K5..K200 ladder, hourly payout pacing, 14 segments
-- Date: 2026-08-19   Spec: docs/superpowers/specs/2026-08-19-prize-ladder-pacing-jackpot-design.md
```

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/2026-08-19-prize-ladder-pacing-jackpot.sql
git commit -m "feat(db): claim_spin with release cap, K5 prize, 14 segments"
```

---

## Task 7: Route and notification wiring

**Files:**
- Modify: `app/api/spin/route.js:88` (forceWin), `:170-190` (rpc args)
- Modify: `lib/telegram.js:14-27`
- Test: `lib/telegram.test.mjs`

- [ ] **Step 1: Write the failing telegram test**

Add to `lib/telegram.test.mjs`:

```js
test('queue mode shows the win ordinal out of the actual pool size', () => {
  const msg = formatWinMessage({
    customerId: '172436', prizeAmount: 5, winsToday: 55,
    budgetSpent: 400, spinNumber: 104, payoutMode: 'queue', poolSize: 250,
  });
  assert.ok(msg.includes('Win #55 of 250'), msg);
});

test('pool size falls back to 250 when not supplied', () => {
  const msg = formatWinMessage({
    customerId: '1', prizeAmount: 5, winsToday: 1,
    budgetSpent: 5, spinNumber: 1, payoutMode: 'queue',
  });
  assert.ok(msg.includes('of 250'), msg);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — message still reads `Win #55 of 100`.

- [ ] **Step 3: Implement in `lib/telegram.js`**

Change the import and the two function signatures:

```js
import { WINNABLE_POSITIONS, POOL_SIZE } from './algorithms.js';
```

```js
export function formatWinMessage({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber, payoutMode = 'positions', poolSize = POOL_SIZE }) {
  const spinLine = payoutMode === 'queue'
    ? `🎡 Win #${winsToday} of ${poolSize}`
    : `🎡 Spin: ${spinNumber}/${WINNABLE_POSITIONS}`;
```

```js
export async function sendWinNotification({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber, payoutMode, poolSize }) {
  const message = formatWinMessage({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber, payoutMode, poolSize });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Wire the route**

In `app/api/spin/route.js`, add to the imports:

```js
import { releaseCap, UNPACED_CAP } from '@/lib/releaseCap';
import { VALID_PRIZE_AMOUNTS } from '@/lib/algorithms';
```

Replace the `forceWin` line (line 88) so a forced prize can never be an invalid amount:

```js
  const forceWin = isTest && typeof body.forceWin === 'number' && VALID_PRIZE_AMOUNTS.includes(body.forceWin)
    ? body.forceWin
    : null;
```

Add the new argument to the `supabase.rpc('claim_spin', {...})` call, after `p_prize_queue`:

```js
    // Hourly pacing: prizes are released on a cumulative schedule so the pot
    // lasts all day instead of draining in the first hour. Test traffic is
    // unpaced. Sending UNPACED_CAP restores the old FCFS behaviour.
    p_release_cap: isTest ? UNPACED_CAP : releaseCap(Date.now()),
```

Pass the pool size to the notification:

```js
        payoutMode: WHEEL_PAYOUT_MODE,
        poolSize: prizeQueue.length,
```

- [ ] **Step 6: Run the full suite and build**

Run: `npm test && npm run build`
Expected: all tests PASS, build compiles clean.

- [ ] **Step 7: Commit**

```bash
git add app/api/spin/route.js lib/telegram.js lib/telegram.test.mjs
git commit -m "feat(spin): pass release cap, whitelist forced prizes, pool-size notification"
```

---

## Task 8: Deploy and verify

Deploy order matters: **Vercel first, migration second.** The new segment indices must never be emitted while the old bundle is still being served.

- [ ] **Step 1: Confirm today's pot is still exhausted**

```sql
select day_date, queue_pos, jsonb_array_length(prize_queue) as queue_len,
       jsonb_array_length(prize_queue) - queue_pos as remaining
from wheel_daily_state where day_date = '2026-08-19';
```

Expected: `remaining = 0`. If it is not 0, STOP — deploying would change live payout behaviour mid-day.

- [ ] **Step 2: Merge and push to trigger the Vercel deploy**

```bash
git checkout main && git merge --no-ff design/prize-ladder-pacing-jackpot
npm test && npm run build
git push origin main
```

- [ ] **Step 3: Confirm the new bundle is live**

Fetch the production page and grep the bundle for the new label. Expected: `K10,000` present.

- [ ] **Step 4: Apply the migration**

Apply `supabase/migrations/2026-08-19-prize-ladder-pacing-jackpot.sql` as ONE statement batch (it is a single transaction; splitting it per-statement breaks the atomic swap).

- [ ] **Step 5: Verify the function swapped cleanly**

```sql
select count(*) as signatures, max(pg_get_function_identity_arguments(p.oid)) as args
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'claim_spin';
```

Expected: `signatures = 1`, args ending in `..., p_prize_queue jsonb, p_release_cap integer`.

- [ ] **Step 6: Verify tonight's spins still lose and still render**

```sql
select segment_index, count(*) from wheel_spin_log
where day_date = '2026-08-19' and created_at > now() - interval '10 minutes'
group by 1 order by 1;
```

Expected: only odd indices from `{1,3,5,7,9,11,13}`, `won = false` throughout.

- [ ] **Step 7: Verify the launch at 06:00 CAT (04:00 UTC)**

```sql
select day_date, jsonb_array_length(prize_queue) as queue_len, queue_pos,
       total_wins, total_budget_spent
from wheel_daily_state where day_date = '2026-08-20';
```

Expected: `queue_len = 250`. If it is NULL, the `v_queue_ok` whitelist is wrong — roll back immediately with `WHEEL_PAYOUT_MODE=positions`.

- [ ] **Step 8: Verify pacing is holding**

After the first two hours, `total_wins` should be at or below 20 (the cumulative cap for wheel hour 1), not 250.

---

## Rollback

| Symptom | Action |
| --- | --- |
| No wins at all on 2026-08-20 (`prize_queue` NULL) | Set `WHEEL_PAYOUT_MODE=positions` in Vercel — env flip, no redeploy |
| Pacing too slow / too fast | Edit `HOURLY_QUOTAS` in `lib/releaseCap.js` and redeploy; no migration needed |
| Pacing needs disabling entirely | Change the route to send `UNPACED_CAP` — restores FCFS with the new ladder |
| Segment rendering broken | Revert the merge commit and redeploy; the SQL is backward-compatible with the old widget only for loss indices 1–9, so also re-apply the 2026-08-12 migration |

---

## Self-review notes

- Spec §4.1 ladder → Task 1. §4.2 pacing → Tasks 3, 6, 7. §4.3 segments → Tasks 1, 5. §4.4 six guarantees → Guarantees 1, 2, 5 in Task 2; 3 and 4 in Task 6; 6 in Tasks 4, 5, 7. §4.5 notification → Task 7. §5 migration/rollback → Tasks 6, 8.
- `POOL_SIZE`, `VALID_PRIZE_AMOUNTS`, `JACKPOT_SEGMENT_INDEX`, `SEGMENT_COUNT`, `WIN_SEGMENTS`, `LOSS_SEGMENTS` are all defined in Task 1 before any later task imports them.
- `resolveLandingSegment` is defined in Task 4 and used in Task 5 under the same name and return shape (`{ index, substituted }`).
- `UNPACED_CAP` (2147483647) matches the SQL default in Task 6 exactly.
