# Wheel of Fortune — Rigged Logic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-side rigged spin logic to the standalone Wheel of Fortune widget so that exactly 100 out of ~10,000 daily spins win, with a K2,000 daily budget distributed across 5 rotating algorithms.

**Architecture:** Next.js API routes handle spin decisions server-side. Supabase stores daily state (algorithm, winning positions, budget) and spin logs. The client sends a spin request, receives which segment to land on, and animates accordingly. A User ID prompt screen gates access before the wheel is shown.

**Tech Stack:** Next.js 14 (App Router), Supabase (existing project `blrrcnrhixckfudiojwe`), Tailwind CSS, Vercel deployment.

**Spec:** `docs/specs/2026-04-15-wheel-of-fortune-rigged-logic-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/supabase.js` | Create | Server-side Supabase client (service role key) |
| `lib/algorithms.js` | Create | 5 prize distributions, weighted selection, day-date helper, daily state initialization |
| `lib/fingerprint.js` | Create | Client-side browser fingerprint generator |
| `lib/telegram.js` | Create | Telegram notification stub (no-op, logs to console) |
| `lib/rateLimit.js` | Create | In-memory IP rate limiter for API routes |
| `app/api/validate/route.js` | Create | POST endpoint — validate customer ID against `customers` table |
| `app/api/spin/route.js` | Create | POST endpoint — core spin logic (win/lose decision, atomic counters, logging) |
| `components/WheelWidget.jsx` | Modify | Add ID prompt screen, API integration, localStorage 6am reset, remove demo features |
| `app/page.js` | Modify | Remove `username` param (not used), keep `userId` for optional pre-fill |

### Database (Supabase)

| Table | Action |
|-------|--------|
| `wheel_daily_state` | Create via SQL |
| `wheel_spin_log` | Create via SQL |

---

## Task 1: Install Supabase + Create Database Tables

**Files:**
- Create: `lib/supabase.js`
- Database: Create tables via Supabase SQL editor

- [ ] **Step 1: Install `@supabase/supabase-js`**

Run from the `wheel-of-fortune` directory:

```bash
npm install @supabase/supabase-js
```

Expected: Package added to `package.json` dependencies.

- [ ] **Step 2: Create `lib/supabase.js`**

```js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey);
```

- [ ] **Step 3: Create database tables**

Run this SQL in the Supabase SQL editor for project `blrrcnrhixckfudiojwe`:

```sql
-- Daily wheel state: one row per day
CREATE TABLE wheel_daily_state (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  day_date date NOT NULL UNIQUE,
  algorithm_id int NOT NULL,
  winning_positions jsonb NOT NULL,
  total_spins int NOT NULL DEFAULT 0,
  total_wins int NOT NULL DEFAULT 0,
  total_budget_spent int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Index for fast lookup by day
CREATE INDEX idx_wheel_daily_state_day ON wheel_daily_state (day_date);

-- Spin log: every spin recorded
CREATE TABLE wheel_spin_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  day_date date NOT NULL,
  customer_id text NOT NULL,
  spin_number int NOT NULL,
  won boolean NOT NULL DEFAULT false,
  prize_amount int NOT NULL DEFAULT 0,
  segment_index int NOT NULL,
  fingerprint text,
  ip_address text,
  created_at timestamptz DEFAULT now()
);

-- Indexes for duplicate-spin checks
CREATE INDEX idx_wheel_spin_log_day_customer ON wheel_spin_log (day_date, customer_id);
CREATE INDEX idx_wheel_spin_log_day_fingerprint ON wheel_spin_log (day_date, fingerprint);
```

- [ ] **Step 4: Add environment variables to `.env.local`**

Create `.env.local` in the project root:

```
SUPABASE_URL=https://blrrcnrhixckfudiojwe.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJscnJjbnJoaXhja2Z1ZGlvandlIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2Nzc3ODQzMywiZXhwIjoyMDgzMzU0NDMzfQ.tqSFj62h4SjfdlGDoK1zpHrdc3PUYJKbRwhC5CKPPE8
```

Make sure `.env.local` is in `.gitignore` (Next.js default — verify it's there).

- [ ] **Step 5: Verify Supabase connection**

Run `npm run dev`, open browser console — no "Missing env vars" errors. Then stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add lib/supabase.js package.json package-lock.json
git commit -m "feat: add Supabase client + install dependency"
```

Note: Do NOT commit `.env.local`. Do NOT commit the SQL — it's run directly in Supabase dashboard.

---

## Task 2: Algorithms + Day-Date Helper

**Files:**
- Create: `lib/algorithms.js`

- [ ] **Step 1: Create `lib/algorithms.js`**

```js
// ============================================================================
// PRIZE DISTRIBUTION ALGORITHMS
// Each totals exactly K2,000 across exactly 100 wins.
// ============================================================================

export const ALGORITHMS = {
  1: { name: 'Drizzle',    prizes: { 10: 55, 20: 35, 50: 7,  100: 2,  200: 1 } },
  2: { name: 'Balanced',   prizes: { 10: 75, 20: 15, 50: 5,  100: 3,  200: 2 } },
  3: { name: 'K50-heavy',  prizes: { 10: 78, 20: 6,  50: 12, 100: 3,  200: 1 } },
  4: { name: 'Top-heavy',  prizes: { 10: 89, 20: 3,  50: 1,  100: 4,  200: 3 } },
  5: { name: 'K20-heavy',  prizes: { 10: 43, 20: 51, 50: 3,  100: 2,  200: 1 } },
};

// Weighted pool: algo 4 (top-heavy) appears once, others twice
const SELECTION_POOL = [1, 1, 2, 2, 3, 3, 4, 5, 5];

/**
 * Pick a random algorithm from the weighted pool.
 */
export function pickAlgorithm() {
  return SELECTION_POOL[Math.floor(Math.random() * SELECTION_POOL.length)];
}

/**
 * Generate the prize pool array for an algorithm.
 * Returns an array of 100 prize amounts (e.g., [10, 10, 10, ..., 20, 20, ..., 200]).
 * The array is shuffled so prizes are randomly assigned to winning positions.
 */
export function generatePrizePool(algorithmId) {
  const algo = ALGORITHMS[algorithmId];
  if (!algo) throw new Error(`Unknown algorithm: ${algorithmId}`);

  const pool = [];
  for (const [amount, count] of Object.entries(algo.prizes)) {
    for (let i = 0; i < count; i++) {
      pool.push(Number(amount));
    }
  }

  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return pool;
}

/**
 * Generate 100 unique random spin positions between 1 and 10,000.
 */
export function generateWinningPositions() {
  const positions = new Set();
  while (positions.size < 100) {
    positions.add(Math.floor(Math.random() * 10000) + 1);
  }
  return Array.from(positions).sort((a, b) => a - b);
}

/**
 * Build the winning_positions map: { "spinNumber": prizeAmount, ... }
 */
export function buildWinningMap(algorithmId) {
  const positions = generateWinningPositions();
  const prizes = generatePrizePool(algorithmId);
  const map = {};
  positions.forEach((pos, i) => {
    map[String(pos)] = prizes[i];
  });
  return map;
}

/**
 * Get the current "wheel day" date string (YYYY-MM-DD).
 * Day resets at 06:00 AM CAT (UTC+2).
 * If current time is before 6am CAT, it's still "yesterday".
 */
export function getWheelDayDate() {
  const now = new Date();
  // Convert to CAT (UTC+2)
  const catMs = now.getTime() + (2 * 60 * 60 * 1000);
  const catDate = new Date(catMs);
  // If before 6am CAT, subtract a day
  const catHour = catDate.getUTCHours();
  if (catHour < 6) {
    catDate.setUTCDate(catDate.getUTCDate() - 1);
  }
  // Return YYYY-MM-DD
  return catDate.toISOString().split('T')[0];
}

/**
 * Map a prize amount to the corresponding wheel segment index (0-based).
 * Prize segments: 0=K10, 2=K50, 4=K200, 6=K20, 8=K100
 */
const PRIZE_TO_SEGMENT = {
  10: 0,
  50: 2,
  200: 4,
  20: 6,
  100: 8,
};

export function prizeToSegmentIndex(prizeAmount) {
  const idx = PRIZE_TO_SEGMENT[prizeAmount];
  if (idx === undefined) throw new Error(`Unknown prize amount: ${prizeAmount}`);
  return idx;
}

/**
 * Pick a random loss segment index.
 * Loss segments are at positions 1, 3, 5, 7, 9 (0-based).
 */
const LOSS_SEGMENTS = [1, 3, 5, 7, 9];

export function pickLossSegment() {
  return LOSS_SEGMENTS[Math.floor(Math.random() * LOSS_SEGMENTS.length)];
}
```

- [ ] **Step 2: Verify algorithm totals are correct**

Quick manual check — run this in Node REPL from the project root:

```bash
node -e "
const A = {1:{10:55,20:35,50:7,100:2,200:1},2:{10:75,20:15,50:5,100:3,200:2},3:{10:78,20:6,50:12,100:3,200:1},4:{10:89,20:3,50:1,100:4,200:3},5:{10:43,20:51,50:3,100:2,200:1}};
for (const [id,p] of Object.entries(A)) {
  let total=0,wins=0;
  for (const [amt,cnt] of Object.entries(p)) { total+=Number(amt)*cnt; wins+=cnt; }
  console.log('Algo '+id+': K'+total+', '+wins+' wins');
}
"
```

Expected output:
```
Algo 1: K2000, 100 wins
Algo 2: K2000, 100 wins
Algo 3: K2000, 100 wins
Algo 4: K2000, 100 wins
Algo 5: K2000, 100 wins
```

- [ ] **Step 3: Commit**

```bash
git add lib/algorithms.js
git commit -m "feat: add 5 prize algorithms + day-date helper"
```

---

## Task 3: Rate Limiter + Telegram Stub

**Files:**
- Create: `lib/rateLimit.js`
- Create: `lib/telegram.js`

- [ ] **Step 1: Create `lib/rateLimit.js`**

```js
// In-memory rate limiter: max requests per IP per window.
// Resets on server restart (fine for Vercel serverless — each cold start is fresh).

const store = new Map();

/**
 * Check if an IP is rate-limited.
 * @param {string} ip
 * @param {number} maxRequests — max requests allowed in the window
 * @param {number} windowMs — time window in milliseconds
 * @returns {boolean} true if request is allowed, false if rate-limited
 */
export function checkRateLimit(ip, maxRequests = 5, windowMs = 60_000) {
  const now = Date.now();
  const key = ip;

  if (!store.has(key)) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  const entry = store.get(key);

  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + windowMs;
    return true;
  }

  entry.count++;
  return entry.count <= maxRequests;
}
```

- [ ] **Step 2: Create `lib/telegram.js`**

```js
/**
 * Send a win notification to the Telegram admin group.
 * Currently a no-op stub — logs to console.
 * To wire up: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars.
 */
export async function sendWinNotification({ customerId, prizeAmount, winsToday, budgetSpent }) {
  const message = [
    '🎉 WHEEL WIN',
    `👤 User ID: ${customerId}`,
    `💰 Prize: K${prizeAmount}`,
    `🕐 Time: ${new Date().toISOString()}`,
    `📈 Daily: ${winsToday}/100 wins | K${budgetSpent}/K2,000 budget`,
  ].join('\n');

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (botToken && chatId) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
      });
    } catch (err) {
      console.error('[Telegram] Failed to send notification:', err.message);
    }
  } else {
    console.log('[Telegram stub]', message);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/rateLimit.js lib/telegram.js
git commit -m "feat: add rate limiter + Telegram notification stub"
```

---

## Task 4: POST `/api/validate` Endpoint

**Files:**
- Create: `app/api/validate/route.js`

- [ ] **Step 1: Create `app/api/validate/route.js`**

```js
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rateLimit';

export async function POST(request) {
  // Rate limit
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ valid: false, error: 'Too many requests' }, { status: 429 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ valid: false, error: 'Invalid request body' }, { status: 400 });
  }

  const { customerId } = body;

  if (!customerId || typeof customerId !== 'string' || customerId.trim() === '') {
    return NextResponse.json({ valid: false, error: 'Customer ID is required' }, { status: 400 });
  }

  const cleanId = customerId.trim();

  // Check if customer exists in CRM
  const { data, error } = await supabase
    .from('customers')
    .select('id')
    .eq('id', cleanId)
    .limit(1)
    .single();

  if (error || !data) {
    return NextResponse.json({ valid: false, error: 'Invalid Customer ID' });
  }

  return NextResponse.json({ valid: true });
}
```

- [ ] **Step 2: Verify with curl**

Start dev server (`npm run dev`), then in another terminal:

```bash
# Valid ID (use an ID that exists — e.g., "2" from the customers table)
curl -X POST http://localhost:3000/api/validate \
  -H "Content-Type: application/json" \
  -d '{"customerId": "2"}'
# Expected: {"valid":true}

# Invalid ID
curl -X POST http://localhost:3000/api/validate \
  -H "Content-Type: application/json" \
  -d '{"customerId": "99999999"}'
# Expected: {"valid":false,"error":"Invalid Customer ID"}
```

- [ ] **Step 3: Commit**

```bash
git add app/api/validate/route.js
git commit -m "feat: add /api/validate endpoint for customer ID check"
```

---

## Task 5: POST `/api/spin` Endpoint

**Files:**
- Create: `app/api/spin/route.js`

This is the core logic — the rigged spin engine.

- [ ] **Step 1: Create `app/api/spin/route.js`**

```js
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rateLimit';
import {
  getWheelDayDate,
  pickAlgorithm,
  buildWinningMap,
  prizeToSegmentIndex,
  pickLossSegment,
} from '@/lib/algorithms';
import { sendWinNotification } from '@/lib/telegram';

/**
 * Get or lazily initialize today's daily state.
 * Uses an upsert with ON CONFLICT to handle race conditions.
 */
async function getOrCreateDailyState(dayDate) {
  // Try to fetch existing state
  const { data: existing } = await supabase
    .from('wheel_daily_state')
    .select('*')
    .eq('day_date', dayDate)
    .single();

  if (existing) return existing;

  // Initialize new day
  const algorithmId = pickAlgorithm();
  const winningPositions = buildWinningMap(algorithmId);

  const { data: created, error } = await supabase
    .from('wheel_daily_state')
    .upsert(
      {
        day_date: dayDate,
        algorithm_id: algorithmId,
        winning_positions: winningPositions,
        total_spins: 0,
        total_wins: 0,
        total_budget_spent: 0,
      },
      { onConflict: 'day_date', ignoreDuplicates: true }
    )
    .select()
    .single();

  // If upsert returned nothing (race condition — another request created it first), fetch it
  if (error || !created) {
    const { data: fetched } = await supabase
      .from('wheel_daily_state')
      .select('*')
      .eq('day_date', dayDate)
      .single();
    return fetched;
  }

  return created;
}

export async function POST(request) {
  // Rate limit
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const { customerId, fingerprint } = body;

  if (!customerId || typeof customerId !== 'string' || customerId.trim() === '') {
    return NextResponse.json({ error: 'missing_customer_id' }, { status: 400 });
  }

  const cleanId = customerId.trim();
  const dayDate = getWheelDayDate();

  // Check: has this customer already spun today?
  const { data: existingSpin } = await supabase
    .from('wheel_spin_log')
    .select('id')
    .eq('day_date', dayDate)
    .eq('customer_id', cleanId)
    .limit(1)
    .single();

  if (existingSpin) {
    return NextResponse.json({ error: 'already_spun' });
  }

  // Check: has this fingerprint already spun today? (secondary check)
  if (fingerprint) {
    const { data: fpSpin } = await supabase
      .from('wheel_spin_log')
      .select('id')
      .eq('day_date', dayDate)
      .eq('fingerprint', fingerprint)
      .limit(1)
      .single();

    if (fpSpin) {
      return NextResponse.json({ error: 'already_spun' });
    }
  }

  // Get or create today's state
  const dailyState = await getOrCreateDailyState(dayDate);
  if (!dailyState) {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  // Atomically increment total_spins and get the new spin number
  const { data: updated, error: updateErr } = await supabase
    .from('wheel_daily_state')
    .update({ total_spins: dailyState.total_spins + 1 })
    .eq('id', dailyState.id)
    .eq('total_spins', dailyState.total_spins) // optimistic lock
    .select('total_spins')
    .single();

  if (updateErr || !updated) {
    // Race condition — retry once by re-fetching state
    const { data: retryState } = await supabase
      .from('wheel_daily_state')
      .select('*')
      .eq('day_date', dayDate)
      .single();

    if (!retryState) {
      return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }

    const { data: retryUpdated, error: retryErr } = await supabase
      .from('wheel_daily_state')
      .update({ total_spins: retryState.total_spins + 1 })
      .eq('id', retryState.id)
      .eq('total_spins', retryState.total_spins)
      .select('total_spins')
      .single();

    if (retryErr || !retryUpdated) {
      return NextResponse.json({ error: 'server_busy' }, { status: 503 });
    }

    // Use retry state for the rest
    Object.assign(dailyState, retryState);
    dailyState.total_spins = retryUpdated.total_spins;
  } else {
    dailyState.total_spins = updated.total_spins;
  }

  const spinNumber = dailyState.total_spins;
  const winningPositions = dailyState.winning_positions;

  // Check if this spin number is a winner
  const prizeAmount = winningPositions[String(spinNumber)];
  const isWin = prizeAmount !== undefined;

  let segmentIndex;
  let finalPrize = 0;

  if (isWin) {
    segmentIndex = prizeToSegmentIndex(prizeAmount);
    finalPrize = prizeAmount;

    // Update daily state: increment wins and budget
    await supabase
      .from('wheel_daily_state')
      .update({
        total_wins: dailyState.total_wins + 1,
        total_budget_spent: dailyState.total_budget_spent + prizeAmount,
      })
      .eq('id', dailyState.id);

    // Send Telegram notification (async, don't await — fire and forget)
    sendWinNotification({
      customerId: cleanId,
      prizeAmount,
      winsToday: dailyState.total_wins + 1,
      budgetSpent: dailyState.total_budget_spent + prizeAmount,
    }).catch(() => {});
  } else {
    segmentIndex = pickLossSegment();
  }

  // Log the spin
  await supabase.from('wheel_spin_log').insert({
    day_date: dayDate,
    customer_id: cleanId,
    spin_number: spinNumber,
    won: isWin,
    prize_amount: finalPrize,
    segment_index: segmentIndex,
    fingerprint: fingerprint || null,
    ip_address: ip,
  });

  return NextResponse.json({
    win: isWin,
    segmentIndex,
    prize: isWin ? { kwacha: prizeAmount } : null,
  });
}
```

- [ ] **Step 2: Verify with curl**

With dev server running:

```bash
# Spin for a valid customer (use ID "2")
curl -X POST http://localhost:3000/api/spin \
  -H "Content-Type: application/json" \
  -d '{"customerId": "2", "fingerprint": "test-fp-123"}'
# Expected: {"win":true/false,"segmentIndex":<0-9>,"prize":{...}|null}

# Try to spin again — should be rejected
curl -X POST http://localhost:3000/api/spin \
  -H "Content-Type: application/json" \
  -d '{"customerId": "2", "fingerprint": "test-fp-123"}'
# Expected: {"error":"already_spun"}
```

- [ ] **Step 3: Check Supabase tables**

Go to Supabase dashboard → Table Editor:
- `wheel_daily_state` should have 1 row for today with algorithm + winning positions
- `wheel_spin_log` should have 1 row for the test spin

- [ ] **Step 4: Clean up test data**

Delete the test rows from Supabase so the wheel is fresh:

```sql
DELETE FROM wheel_spin_log WHERE customer_id = '2';
DELETE FROM wheel_daily_state;
```

- [ ] **Step 5: Commit**

```bash
git add app/api/spin/route.js
git commit -m "feat: add /api/spin endpoint with rigged logic engine"
```

---

## Task 6: Client-Side Browser Fingerprint

**Files:**
- Create: `lib/fingerprint.js`

- [ ] **Step 1: Create `lib/fingerprint.js`**

This runs in the browser (client-side). It generates a simple hash from browser signals.

```js
/**
 * Generate a simple browser fingerprint from available signals.
 * Not meant to be bulletproof — just a secondary duplicate check.
 */
export async function generateFingerprint() {
  const signals = [];

  // Screen
  signals.push(`${screen.width}x${screen.height}x${screen.colorDepth}`);

  // Timezone
  signals.push(Intl.DateTimeFormat().resolvedOptions().timeZone);

  // Language
  signals.push(navigator.language);

  // Platform
  signals.push(navigator.platform);

  // Canvas fingerprint
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 200;
    canvas.height = 50;
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('BwanaBet', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('BwanaBet', 4, 17);
    signals.push(canvas.toDataURL());
  } catch {
    signals.push('no-canvas');
  }

  // Hash the signals
  const raw = signals.join('|');
  const encoder = new TextEncoder();
  const data = encoder.encode(raw);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/fingerprint.js
git commit -m "feat: add client-side browser fingerprint generator"
```

---

## Task 7: Rewrite WheelWidget.jsx — API Integration + ID Prompt

**Files:**
- Modify: `components/WheelWidget.jsx`
- Modify: `app/page.js`

This is the largest task. The widget gets three new screens/states:
1. **ID Prompt** — user enters their customer ID
2. **Wheel** — existing wheel, but spin result comes from API
3. **Done** — "Try Again Tomorrow!" permanent screen after spinning

- [ ] **Step 1: Update `app/page.js`**

Remove the `username` param (not used by bwanabet CRM). Keep `userId` for optional pre-fill.

Replace the entire file:

```js
'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import WheelWidget from '@/components/WheelWidget';

function WheelPage() {
  const params = useSearchParams();
  const userId = params.get('userId') || null;

  return <WheelWidget prefillUserId={userId} />;
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <WheelPage />
    </Suspense>
  );
}
```

- [ ] **Step 2: Rewrite `components/WheelWidget.jsx`**

The full rewrite modifies these parts of the existing widget:

**A) Add imports and constants at top (after existing imports):**

Add this import at the top of the file, after the `lucide-react` import:

```js
import { generateFingerprint } from '@/lib/fingerprint';
```

**B) Change the component signature:**

Replace:
```js
export default function WheelWidget({ userId = null, username = null }) {
```

With:
```js
// localStorage key + 6am reset helper
const STORAGE_KEY = 'bwanabet_wheel_spin';

function getWheelDayClient() {
  const now = new Date();
  // Convert to CAT (UTC+2) by adding 2 hours in ms
  const catMs = now.getTime() + (2 * 60 * 60 * 1000);
  const catDate = new Date(catMs);
  // If before 6am CAT, it's still yesterday's wheel day
  if (catDate.getUTCHours() < 6) {
    catDate.setUTCDate(catDate.getUTCDate() - 1);
  }
  return catDate.toISOString().split('T')[0];
}

function hasSpunToday() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return false;
    const { day } = JSON.parse(stored);
    return day === getWheelDayClient();
  } catch { return false; }
}

function markSpun() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ day: getWheelDayClient() }));
}

export default function WheelWidget({ prefillUserId = null }) {
```

**C) Replace state declarations (lines ~79-91):**

Replace everything from `const [phase, setPhase]` through `const [floatingNums, setFloatingNums]` with:

```js
  // Widget screens: 'checking' → 'prompt' → 'spinning' → 'stopping' → 'result' → 'done'
  const [screen, setScreen] = useState('checking');
  const [customerId, setCustomerId] = useState(prefillUserId || '');
  const [validationError, setValidationError] = useState('');
  const [validating, setValidating] = useState(false);
  const [spinResult, setSpinResult] = useState(null); // { win, segmentIndex, prize }

  // Existing wheel state
  const [showFlash, setShowFlash] = useState(false);
  const [pointerBouncing, setPointerBouncing] = useState(false);
  const [wheelConfetti, setWheelConfetti] = useState(false);
  const [closed, setClosed] = useState(false);
  const { canvasRef, spawnParticles, startLoop } = useParticleSystem();
  const [floatingNums, setFloatingNums] = useState([]);

  const fingerprintRef = useRef(null);
```

**D) Add localStorage check on mount (after fingerprintRef):**

```js
  // On mount: check localStorage, generate fingerprint
  useEffect(() => {
    if (hasSpunToday()) {
      setScreen('done');
    } else {
      setScreen('prompt');
    }
    generateFingerprint().then(fp => { fingerprintRef.current = fp; }).catch(() => {});
  }, []);
```

**E) Add validate + spin API functions (after the useEffect above):**

```js
  const handleValidateAndPlay = async () => {
    const id = customerId.trim();
    if (!id) { setValidationError('Please enter your Customer ID'); return; }

    setValidating(true);
    setValidationError('');

    try {
      const res = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: id }),
      });
      const data = await res.json();

      if (!data.valid) {
        setValidationError(data.error || 'Invalid Customer ID');
        setValidating(false);
        return;
      }

      // Valid — start the wheel spinning
      setScreen('spinning');
      setPointerBouncing(true);
      setValidating(false);
    } catch {
      setValidationError('Connection error. Please try again.');
      setValidating(false);
    }
  };
```

**F) Modify the `stopWheel` function:**

Replace the existing `stopWheel` function (the `useCallback` that picks a random winner) with:

```js
  const stopWheel = useCallback(async () => {
    if (screen !== 'spinning') return;
    setScreen('stopping');

    try {
      const res = await fetch('/api/spin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: customerId.trim(),
          fingerprint: fingerprintRef.current,
        }),
      });
      const data = await res.json();

      if (data.error) {
        // Already spun or other error — go to done
        markSpun();
        setScreen('done');
        return;
      }

      // Store the result — the deceleration animation will use it
      setSpinResult(data);
      winSegmentRef.current = WHEEL_SEGMENTS[data.segmentIndex];

      // Calculate target angle for the server-chosen segment
      const segCenter = data.segmentIndex * SEG_ANGLE + SEG_ANGLE / 2;
      const jitter = (Math.random() - 0.5) * (SEG_ANGLE * 0.5);
      const targetRemainder = (360 - segCenter + jitter + 360) % 360;

      const currentAngle = spinAngleRef.current;
      let remaining = targetRemainder - (currentAngle % 360);
      if (remaining <= 0) remaining += 360;
      const extraSpins = (2 + Math.floor(Math.random() * 2)) * 360;

      decelFromRef.current = currentAngle;
      decelTotalRef.current = extraSpins + remaining;
      decelStartRef.current = performance.now();

      // Mark as spun in localStorage
      markSpun();
    } catch {
      markSpun();
      setScreen('done');
    }
  }, [screen, customerId]);
```

**G) Modify the deceleration-complete callback in the animation loop:**

In the existing `useEffect` animation loop, find the block that starts `if (t >= 1) {` (around line 132). Replace the block from `decelStartRef.current = null;` through `return; // stop loop` with:

```js
          decelStartRef.current = null;
          const segment = winSegmentRef.current;
          setPointerBouncing(false);

          if (segment && !segment.isLoss) {
            setShowFlash(true);
            setWheelConfetti(true);
            setTimeout(() => setShowFlash(false), 400);
            setTimeout(() => setWheelConfetti(false), 3000);
            const cx = window.innerWidth / 2, cy = window.innerHeight * 0.45;
            spawnParticles(cx, cy, 25, { spread: 250, speed: 9, life: 40, gravity: 0.2, emojis: ['🪙','💰','✨','🎉'] });
            spawnParticles(cx, cy, 15, { spread: 180, speed: 6, life: 30, gravity: 0.15, emojis: ['✨','🌟','💫'] });
            startLoop();
            if (segment.prize?.kwacha) spawnFloatingNumber(`+K${segment.prize.kwacha}`, cx, cy - 40, '#fbbf24');
          }

          // Show result overlay, then transition to done
          setScreen('result');
          spinFrameRef.current = null;
          return;
```

**H) Replace the `claimPrize` function:**

Replace the existing `claimPrize` callback with:

```js
  const claimPrize = useCallback(() => {
    setSpinResult(null);
    setScreen('done');
  }, []);
```

**I) Modify the animation loop start condition:**

The existing `useEffect` (the animation loop) starts the wheel spinning immediately on mount. Change it so it only starts when `screen === 'spinning'`:

Replace the `useEffect` dependency array and startup logic. The easiest approach: keep the existing useEffect but wrap the `requestAnimationFrame` start in a condition:

Find:
```js
  }, []);
```
(the closing of the animation useEffect)

Replace the entire animation `useEffect` with:

```js
  // Main animation loop — starts when screen becomes 'spinning'
  useEffect(() => {
    if (screen !== 'spinning' && screen !== 'stopping' && screen !== 'result') return;
    let cancelled = false;
    const loop = (timestamp) => {
      if (cancelled) return;
      if (decelStartRef.current !== null) {
        const elapsed = timestamp - decelStartRef.current;
        const t = Math.min(elapsed / DECEL_DURATION, 1);
        const progress = easeOutCubic(t);
        spinAngleRef.current = decelFromRef.current + decelTotalRef.current * progress;

        if (wheelRef.current) {
          wheelRef.current.style.transform = `rotate(${spinAngleRef.current}deg)`;
        }

        if (t >= 1) {
          decelStartRef.current = null;
          const segment = winSegmentRef.current;
          setPointerBouncing(false);

          if (segment && !segment.isLoss) {
            setShowFlash(true);
            setWheelConfetti(true);
            setTimeout(() => setShowFlash(false), 400);
            setTimeout(() => setWheelConfetti(false), 3000);
            const cx = window.innerWidth / 2, cy = window.innerHeight * 0.45;
            spawnParticles(cx, cy, 25, { spread: 250, speed: 9, life: 40, gravity: 0.2, emojis: ['🪙','💰','✨','🎉'] });
            spawnParticles(cx, cy, 15, { spread: 180, speed: 6, life: 30, gravity: 0.15, emojis: ['✨','🌟','💫'] });
            startLoop();
            if (segment.prize?.kwacha) spawnFloatingNumber(`+K${segment.prize.kwacha}`, cx, cy - 40, '#fbbf24');
          }

          setScreen('result');
          spinFrameRef.current = null;
          return;
        }
      } else {
        spinAngleRef.current += SPIN_SPEED;
        if (wheelRef.current) {
          wheelRef.current.style.transform = `rotate(${spinAngleRef.current}deg)`;
        }
      }
      spinFrameRef.current = requestAnimationFrame(loop);
    };
    spinFrameRef.current = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      if (spinFrameRef.current) { cancelAnimationFrame(spinFrameRef.current); spinFrameRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);
```

**J) Replace the return/render section:**

Replace everything from `if (closed) return null;` to the end of the component with:

```js
  if (closed) return null;

  const WHEEL_SIZE = 320;
  const isSpinning = screen === 'spinning' || screen === 'stopping';

  // SCREEN: Checking localStorage
  if (screen === 'checking') {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
        <div className="text-gray-400 text-sm">Loading...</div>
      </div>
    );
  }

  // SCREEN: Already spun today
  if (screen === 'done') {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
        <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none z-[60]" />
        <div className="relative rounded-2xl text-center p-8 mx-4 max-w-xs" style={{
          background: 'linear-gradient(180deg, #2d3348 0%, #1e2233 40%, #1a1e2e 100%)',
          border: '3px solid #3a3f52',
          boxShadow: '0 0 80px rgba(0,0,0,0.8)',
          animation: 'scaleIn 0.3s ease-out',
        }}>
          <button type="button" onClick={() => { setClosed(true); window.parent.postMessage({ type: 'bwanabet-wheel-close' }, '*'); }}
            className="absolute top-3 right-3 z-40 w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-90"
            style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 2px 8px rgba(239,68,68,0.5)' }}>
            <X className="w-5 h-5 text-white" strokeWidth={3} />
          </button>
          <div className="text-6xl mb-4" style={{ animation: 'float 2s ease-in-out infinite' }}>😢</div>
          <div className="text-2xl font-black text-gray-300 mb-2">Try Again Tomorrow!</div>
          <p className="text-gray-500 text-sm">Come back after 6:00 AM for a new spin.</p>
        </div>
      </div>
    );
  }

  // SCREEN: ID Prompt
  if (screen === 'prompt') {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
        <div className="relative rounded-2xl p-6 mx-4 max-w-xs w-full" style={{
          background: 'linear-gradient(180deg, #2d3348 0%, #1e2233 40%, #1a1e2e 100%)',
          border: '3px solid #3a3f52',
          boxShadow: '0 0 80px rgba(0,0,0,0.8)',
          animation: 'scaleIn 0.3s ease-out',
        }}>
          <button type="button" onClick={() => { setClosed(true); window.parent.postMessage({ type: 'bwanabet-wheel-close' }, '*'); }}
            className="absolute top-3 right-3 z-40 w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-90"
            style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 2px 8px rgba(239,68,68,0.5)' }}>
            <X className="w-5 h-5 text-white" strokeWidth={3} />
          </button>

          <div className="text-center mb-5">
            <div className="text-5xl mb-3">🎡</div>
            <h1 className="text-2xl font-black" style={{
              background: 'linear-gradient(180deg, #ffeaa0 0%, #ffd700 30%, #ff9500 70%, #cc7000 100%)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
            }}>SPIN & WIN</h1>
            <p className="text-gray-400 text-sm mt-1">Enter your BwanaBet ID to play</p>
          </div>

          <div className="space-y-3">
            <input
              type="text"
              inputMode="numeric"
              placeholder="Your Customer ID"
              value={customerId}
              onChange={(e) => { setCustomerId(e.target.value); setValidationError(''); }}
              onKeyDown={(e) => e.key === 'Enter' && handleValidateAndPlay()}
              className="w-full px-4 py-3 rounded-xl text-center text-lg font-bold bg-black/40 border border-gray-600 text-white placeholder-gray-500 focus:outline-none focus:border-amber-500 transition-colors"
              disabled={validating}
            />
            {validationError && (
              <p className="text-red-400 text-sm text-center">{validationError}</p>
            )}
            <button
              type="button"
              onClick={handleValidateAndPlay}
              disabled={validating}
              className="w-full py-3.5 rounded-xl font-bold text-lg shadow-lg transition-all hover:scale-[1.03] active:scale-95 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700"
              style={{ boxShadow: '0 4px 15px rgba(245,158,11,0.3)' }}
            >
              {validating ? 'Checking...' : 'Play!'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // SCREENS: spinning / stopping / result — the wheel UI
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>

      {/* Particle canvas */}
      <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none z-[60]" />

      {/* Floating numbers */}
      {floatingNums.map(n => (
        <div key={n.id} className="fixed pointer-events-none z-[60] font-black text-2xl" style={{
          left: n.x, top: n.y, color: n.color, textShadow: `0 0 10px ${n.color}`,
          animation: 'slideUp 1.2s ease-out forwards', transform: 'translate(-50%, -50%)',
        }}>{n.text}</div>
      ))}

      {/* Screen flash */}
      {showFlash && (
        <div className="fixed inset-0 z-[55] pointer-events-none" style={{
          background: 'radial-gradient(circle, rgba(251,191,36,0.5) 0%, rgba(168,85,247,0.3) 50%, transparent 80%)',
          animation: 'screenFlash 0.4s ease-out forwards',
        }} />
      )}

      {/* Confetti */}
      {wheelConfetti && (
        <div className="fixed inset-0 pointer-events-none z-[55] overflow-hidden">
          {Array.from({ length: 60 }, (_, i) => {
            const colors = ['#fbbf24','#a855f7','#ec4899','#22c55e','#3b82f6','#f97316','#ef4444','#14b8a6'];
            const shape = ['circle','rect','star'][i % 3];
            const size = 6 + Math.random() * 10;
            return (
              <div key={i} style={{
                position: 'absolute', left: `${5 + Math.random() * 90}%`, top: '-20px',
                width: shape === 'rect' ? size * 0.6 : size, height: shape === 'star' ? size * 0.4 : size,
                backgroundColor: colors[i % colors.length], borderRadius: shape === 'circle' ? '50%' : '2px',
                '--drift': `${(Math.random() - 0.5) * 120}px`,
                animation: `confettiFall ${2.2 + Math.random() * 1.5}s ${Math.random() * 0.8}s cubic-bezier(0.25,0.46,0.45,0.94) both`,
              }} />
            );
          })}
        </div>
      )}

      {/* WIN / LOSS RESULT OVERLAY */}
      {screen === 'result' && winSegmentRef.current && (
        <div className="fixed inset-0 z-[58] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', animation: 'fadeIn 0.3s ease-out' }}>
          <div className="text-center p-8 rounded-3xl max-w-xs w-full mx-4" style={{
            background: 'linear-gradient(180deg, rgba(30,40,60,0.95), rgba(15,20,35,0.98))',
            border: `2px solid ${winSegmentRef.current.isLoss ? 'rgba(156,163,175,0.3)' : 'rgba(251,191,36,0.3)'}`,
            boxShadow: winSegmentRef.current.isLoss
              ? '0 0 60px rgba(100,100,100,0.1), 0 20px 60px rgba(0,0,0,0.5)'
              : '0 0 60px rgba(251,191,36,0.15), 0 20px 60px rgba(0,0,0,0.5)',
            animation: 'resultZoom 0.5s cubic-bezier(0.34,1.56,0.64,1) both',
          }}>
            <div className="text-6xl mb-3" style={{ animation: 'float 2s ease-in-out infinite' }}>{winSegmentRef.current.icon}</div>
            {winSegmentRef.current.isLoss ? (
              <>
                <div className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-1">Better Luck</div>
                <div className="text-2xl font-black text-gray-300 mb-5">Try Again Tomorrow</div>
              </>
            ) : (
              <>
                <div className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-1">You Won</div>
                <div className="text-3xl font-black text-yellow-400 mb-5" style={{ textShadow: '0 0 20px rgba(251,191,36,0.5)' }}>
                  K{winSegmentRef.current.prize.kwacha}
                </div>
              </>
            )}
            <button
              type="button"
              onClick={claimPrize}
              className={`w-full py-3.5 rounded-xl font-bold text-lg shadow-lg transition-all hover:scale-[1.03] active:scale-95 ${
                winSegmentRef.current.isLoss
                  ? 'bg-gradient-to-r from-gray-500 to-gray-600 hover:from-gray-600 hover:to-gray-700 shadow-gray-500/20'
                  : 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 shadow-green-500/30'
              }`}
              style={winSegmentRef.current.isLoss ? {} : { '--btn-shadow': '#065F46', '--btn-glow': 'rgba(16,185,129,0.3)', '--btn-glow2': 'rgba(16,185,129,0.15)', animation: 'collectBtnPulse 2s ease-in-out infinite' }}
            >
              {winSegmentRef.current.isLoss ? 'OK' : 'Claim Prize!'}
            </button>
          </div>
        </div>
      )}

      {/* MAIN CARD — wheel UI (existing markup, unchanged) */}
      <div className="relative rounded-2xl" style={{
        width: 380, maxWidth: '95vw',
        background: 'linear-gradient(180deg, #2d3348 0%, #1e2233 40%, #1a1e2e 100%)',
        boxShadow: '0 0 80px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.06)',
        border: '3px solid #3a3f52',
      }}>

        {/* Marquee light dots — keep existing */}
        <div className="absolute inset-0 pointer-events-none z-30 rounded-2xl overflow-hidden">
          {Array.from({ length: 28 }, (_, i) => (
            <div key={`mt${i}`} className="absolute rounded-full" style={{
              width: 4, height: 4, top: 3, left: `${(i + 1) * (100 / 29)}%`,
              background: '#fbbf24', boxShadow: '0 0 4px #fbbf24, 0 0 8px #fbbf2480',
              animation: `marqueeLight 1.5s ${i * 0.05}s ease-in-out infinite`,
            }} />
          ))}
          {Array.from({ length: 28 }, (_, i) => (
            <div key={`mb${i}`} className="absolute rounded-full" style={{
              width: 4, height: 4, bottom: 3, left: `${(i + 1) * (100 / 29)}%`,
              background: '#fbbf24', boxShadow: '0 0 4px #fbbf24, 0 0 8px #fbbf2480',
              animation: `marqueeLight 1.5s ${(i + 14) * 0.05}s ease-in-out infinite`,
            }} />
          ))}
          {Array.from({ length: 18 }, (_, i) => (
            <div key={`ml${i}`} className="absolute rounded-full" style={{
              width: 4, height: 4, left: 3, top: `${(i + 1) * (100 / 19)}%`,
              background: '#fbbf24', boxShadow: '0 0 4px #fbbf24, 0 0 8px #fbbf2480',
              animation: `marqueeLight 1.5s ${(i + 28) * 0.05}s ease-in-out infinite`,
            }} />
          ))}
          {Array.from({ length: 18 }, (_, i) => (
            <div key={`mr${i}`} className="absolute rounded-full" style={{
              width: 4, height: 4, right: 3, top: `${(i + 1) * (100 / 19)}%`,
              background: '#fbbf24', boxShadow: '0 0 4px #fbbf24, 0 0 8px #fbbf2480',
              animation: `marqueeLight 1.5s ${(i + 46) * 0.05}s ease-in-out infinite`,
            }} />
          ))}
        </div>

        {/* Close button */}
        <button type="button" onClick={() => { setClosed(true); window.parent.postMessage({ type: 'bwanabet-wheel-close' }, '*'); }}
          className="absolute top-3 right-3 z-40 w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-90"
          style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 2px 8px rgba(239,68,68,0.5)' }}>
          <X className="w-5 h-5 text-white" strokeWidth={3} />
        </button>

        <div className="relative z-10 px-4 sm:px-5 pt-4 pb-4">

          {/* Header */}
          <div className="flex items-start justify-between mb-2">
            <div>
              <h1 className="text-4xl sm:text-[42px] font-black tracking-tight leading-[0.85]" style={{
                background: 'linear-gradient(180deg, #ffeaa0 0%, #ffd700 30%, #ff9500 70%, #cc7000 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
              }}>SPIN</h1>
              <div className="-mt-0.5 mb-0.5">
                <span className="text-[9px] font-bold tracking-[0.35em] text-gray-500">A N D</span>
              </div>
              <h1 className="text-4xl sm:text-[42px] font-black tracking-tight leading-[0.85]" style={{
                background: 'linear-gradient(180deg, #ffeaa0 0%, #ffd700 30%, #ff9500 70%, #cc7000 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
              }}>WIN</h1>
            </div>
          </div>

          {/* WHEEL AREA — keep all existing wheel SVG/animation markup exactly as-is */}
          <div className="relative mx-auto" style={{ width: '100%', maxWidth: WHEEL_SIZE + 50, aspectRatio: '1' }}>

            {/* All existing wheel internals: spotlight, sparkles, drop shadow, chrome frame,
                chasing lights, pegs, pointer, spinning wheel SVG, center hub with STOP button.
                These are UNCHANGED from the current file. Keep them exactly as they are. */}

            {/* === SPOTLIGHT behind wheel === */}
            <div className="absolute pointer-events-none" style={{
              inset: '-20%',
              background: 'radial-gradient(circle at 50% 48%, rgba(200,210,230,0.15) 0%, rgba(150,160,180,0.07) 30%, transparent 60%)',
            }} />

            <div className="absolute pointer-events-none text-white/40" style={{ top: '5%', left: '2%', fontSize: 18, animation: 'sparkle 2.5s 0.3s ease-in-out infinite' }}>✦</div>
            <div className="absolute pointer-events-none text-white/30" style={{ top: '12%', right: '4%', fontSize: 14, animation: 'sparkle 2.5s 1s ease-in-out infinite' }}>✦</div>
            <div className="absolute pointer-events-none text-white/25" style={{ bottom: '10%', left: '4%', fontSize: 12, animation: 'sparkle 2.5s 1.6s ease-in-out infinite' }}>✦</div>
            <div className="absolute pointer-events-none text-white/35" style={{ bottom: '5%', right: '2%', fontSize: 16, animation: 'sparkle 2.5s 0.7s ease-in-out infinite' }}>✦</div>

            <div className="absolute pointer-events-none rounded-full" style={{
              left: '8%', right: '8%', bottom: '-2%', height: '12%',
              background: 'radial-gradient(ellipse, rgba(0,0,0,0.35) 0%, transparent 70%)',
              filter: 'blur(8px)',
            }} />

            <svg viewBox="0 0 400 400" className="absolute inset-0 w-full h-full z-20 pointer-events-none">
              <defs>
                <linearGradient id="chrome1" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#e8e8e8" />
                  <stop offset="12%" stopColor="#fff" />
                  <stop offset="28%" stopColor="#888" />
                  <stop offset="42%" stopColor="#e8e8e8" />
                  <stop offset="55%" stopColor="#fff" />
                  <stop offset="68%" stopColor="#999" />
                  <stop offset="82%" stopColor="#e0e0e0" />
                  <stop offset="100%" stopColor="#bbb" />
                </linearGradient>
                <linearGradient id="chrome2" x1="100%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="#ddd" />
                  <stop offset="25%" stopColor="#fff" />
                  <stop offset="50%" stopColor="#777" />
                  <stop offset="75%" stopColor="#e0e0e0" />
                  <stop offset="100%" stopColor="#bbb" />
                </linearGradient>
                <filter id="chromeGlow" x="-8%" y="-8%" width="116%" height="116%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b" />
                  <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
                <filter id="lightGlow" x="-150%" y="-150%" width="400%" height="400%">
                  <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="b" />
                  <feMerge><feMergeNode in="b" /><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>
              <circle cx="200" cy="200" r="194" fill="none" stroke="url(#chrome1)" strokeWidth="12" filter="url(#chromeGlow)" />
              <path d="M 80 120 A 190 190 0 0 1 280 70" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" opacity="0.35" filter="url(#chromeGlow)" />
              <path d="M 90 125 A 185 185 0 0 1 270 78" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.2" />
              <circle cx="200" cy="200" r="184" fill="none" stroke="#12151f" strokeWidth="10" />
              <circle cx="200" cy="200" r="176" fill="none" stroke="url(#chrome2)" strokeWidth="6" />
              <path d="M 95 140 A 170 170 0 0 1 260 90" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.18" />
              <circle cx="200" cy="200" r="171" fill="none" stroke="#1a1e2e" strokeWidth="2" />
              {Array.from({ length: 36 }, (_, i) => {
                const deg = i * 10 - 90;
                const lR = 184;
                const lx = 200 + lR * Math.cos(deg * Math.PI / 180);
                const ly = 200 + lR * Math.sin(deg * Math.PI / 180);
                const colors = ['#fbbf24','#ffffff','#ec4899','#ffffff','#a855f7','#ffffff','#22c55e','#ffffff','#3b82f6','#ffffff','#f97316','#ffffff'];
                const c = colors[i % colors.length];
                return (
                  <circle key={`ol-${i}`} cx={lx} cy={ly} r="4" fill={c} filter="url(#lightGlow)">
                    <animate attributeName="opacity" values="0.15;1;0.15" dur="2.4s" begin={`${(i * 0.067).toFixed(2)}s`} repeatCount="indefinite" />
                    <animate attributeName="r" values="3;5.5;3" dur="2.4s" begin={`${(i * 0.067).toFixed(2)}s`} repeatCount="indefinite" />
                  </circle>
                );
              })}
              {WHEEL_SEGMENTS.map((_, i) => {
                const a = i * SEG_ANGLE - 90;
                const px = 200 + 175 * Math.cos(a * Math.PI / 180);
                const py = 200 + 175 * Math.sin(a * Math.PI / 180);
                return (
                  <g key={`peg${i}`}>
                    <circle cx={px} cy={py} r="5" fill="#1a1e2e" stroke="#b8860b" strokeWidth="1.2" />
                    <circle cx={px} cy={py} r="3" fill="#fbbf24">
                      {isSpinning && <animate attributeName="opacity" values="1;0.3;1" dur={`${0.3 + (i % 3) * 0.12}s`} repeatCount="indefinite" />}
                    </circle>
                  </g>
                );
              })}
            </svg>

            <div className="absolute z-30" style={{
              top: -4, left: '50%', transform: 'translateX(-50%)',
              animation: pointerBouncing ? 'pointerBounce 0.15s ease-in-out infinite' : 'none',
            }}>
              <svg width="40" height="48" viewBox="0 0 40 48" style={{ filter: 'drop-shadow(0 3px 8px rgba(0,0,0,0.7))' }}>
                <defs>
                  <linearGradient id="ptrGold" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#ffd700" />
                    <stop offset="40%" stopColor="#b8860b" />
                    <stop offset="100%" stopColor="#ffd700" />
                  </linearGradient>
                </defs>
                <polygon points="20,46 2,16 38,16" fill="url(#ptrGold)" stroke="#8b6914" strokeWidth="1" />
                <polygon points="20,38 9,19 31,19" fill="#ffd700" opacity="0.35" />
                <circle cx="20" cy="12" r="11" fill="#1a1a1a" stroke="#b8860b" strokeWidth="2" />
                <circle cx="20" cy="12" r="8" fill="#222" />
                <circle cx="16" cy="9" r="3" fill="white" opacity="0.2" />
              </svg>
            </div>

            <div
              ref={wheelRef}
              className="absolute rounded-full overflow-hidden"
              style={{
                top: '7%', left: '7%', right: '7%', bottom: '7%',
                willChange: isSpinning ? 'transform' : 'auto',
              }}
            >
              <svg viewBox="0 0 300 300" className="w-full h-full">
                <defs>
                  <linearGradient id="segGloss" x1="50%" y1="0%" x2="50%" y2="100%">
                    <stop offset="0%" stopColor="#fff" stopOpacity="0.1" />
                    <stop offset="40%" stopColor="#fff" stopOpacity="0.02" />
                    <stop offset="100%" stopColor="#000" stopOpacity="0" />
                  </linearGradient>
                  <radialGradient id="innerGlow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#fff" stopOpacity="0.2" />
                    <stop offset="15%" stopColor="#fff" stopOpacity="0.08" />
                    <stop offset="30%" stopColor="#fff" stopOpacity="0" />
                    <stop offset="100%" stopColor="#000" stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id="rimDarken" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#000" stopOpacity="0" />
                    <stop offset="75%" stopColor="#000" stopOpacity="0" />
                    <stop offset="90%" stopColor="#000" stopOpacity="0.1" />
                    <stop offset="100%" stopColor="#000" stopOpacity="0.2" />
                  </radialGradient>
                </defs>
                {WHEEL_SEGMENTS.map((seg, i) => {
                  const sA = i * SEG_ANGLE - 90;
                  const eA = sA + SEG_ANGLE;
                  const s = { x: 150 + 148 * Math.cos(sA * Math.PI / 180), y: 150 + 148 * Math.sin(sA * Math.PI / 180) };
                  const e = { x: 150 + 148 * Math.cos(eA * Math.PI / 180), y: 150 + 148 * Math.sin(eA * Math.PI / 180) };
                  const path = `M 150 150 L ${s.x} ${s.y} A 148 148 0 0 1 ${e.x} ${e.y} Z`;
                  return (
                    <g key={seg.id}>
                      <path d={path} fill={seg.color} />
                      <path d={path} fill="url(#segGloss)" />
                    </g>
                  );
                })}
                {WHEEL_SEGMENTS.map((_, i) => {
                  const a = i * SEG_ANGLE - 90;
                  const ex = 150 + 148 * Math.cos(a * Math.PI / 180);
                  const ey = 150 + 148 * Math.sin(a * Math.PI / 180);
                  return (
                    <g key={`d${i}`}>
                      <line x1="150" y1="150" x2={ex} y2={ey} stroke="rgba(0,0,0,0.4)" strokeWidth="2.5" />
                      <line x1="150" y1="150" x2={ex} y2={ey} stroke="rgba(255,255,255,0.06)" strokeWidth="1" transform="translate(0.5,0.5)" />
                    </g>
                  );
                })}
                <circle cx="150" cy="150" r="148" fill="url(#innerGlow)" />
                <circle cx="150" cy="150" r="148" fill="url(#rimDarken)" />
                {WHEEL_SEGMENTS.map((seg, i) => {
                  const midAngle = i * SEG_ANGLE - 90 + SEG_ANGLE / 2;
                  if (seg.isLoss) {
                    return (
                      <g key={`t${i}`} transform={`rotate(${midAngle}, 150, 150)`}>
                        <text x={150 + 88} y={150 - 6} textAnchor="middle" dominantBaseline="central"
                          fill="white" fontSize="9.5" fontWeight="900" fontFamily="Arial Black, Arial, sans-serif"
                          stroke="rgba(0,0,0,0.6)" strokeWidth="2.5" paintOrder="stroke" letterSpacing="0.3">
                          TRY AGAIN
                        </text>
                        <text x={150 + 88} y={150 + 6} textAnchor="middle" dominantBaseline="central"
                          fill="white" fontSize="9.5" fontWeight="900" fontFamily="Arial Black, Arial, sans-serif"
                          stroke="rgba(0,0,0,0.6)" strokeWidth="2.5" paintOrder="stroke" letterSpacing="0.3">
                          TOMORROW
                        </text>
                      </g>
                    );
                  }
                  return (
                    <g key={`t${i}`} transform={`rotate(${midAngle}, 150, 150)`}>
                      <text x={150 + 85} y={150} textAnchor="middle" dominantBaseline="central"
                        fill="white" fontSize="22" fontWeight="900" fontFamily="Arial Black, Arial, sans-serif"
                        stroke="rgba(0,0,0,0.6)" strokeWidth="3" paintOrder="stroke" letterSpacing="2">
                        {seg.label}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20" style={{ width: '22%', height: '22%' }}>
              <svg viewBox="0 0 90 90" className="w-full h-full">
                <defs>
                  <radialGradient id="hubSphere" cx="38%" cy="28%" r="65%">
                    <stop offset="0%" stopColor="#aaa" />
                    <stop offset="10%" stopColor="#777" />
                    <stop offset="30%" stopColor="#3a3a3a" />
                    <stop offset="55%" stopColor="#151515" />
                    <stop offset="100%" stopColor="#000" />
                  </radialGradient>
                  <linearGradient id="hubChrome" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#e8e8e8" />
                    <stop offset="15%" stopColor="#fff" />
                    <stop offset="35%" stopColor="#666" />
                    <stop offset="55%" stopColor="#fff" />
                    <stop offset="75%" stopColor="#888" />
                    <stop offset="100%" stopColor="#ccc" />
                  </linearGradient>
                  <radialGradient id="hubSpec" cx="32%" cy="22%">
                    <stop offset="0%" stopColor="#fff" stopOpacity="0.85" />
                    <stop offset="20%" stopColor="#fff" stopOpacity="0.4" />
                    <stop offset="50%" stopColor="#fff" stopOpacity="0.08" />
                    <stop offset="100%" stopColor="#fff" stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id="hubRim" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#000" stopOpacity="0" />
                    <stop offset="75%" stopColor="#000" stopOpacity="0" />
                    <stop offset="100%" stopColor="#fff" stopOpacity="0.08" />
                  </radialGradient>
                </defs>
                <circle cx="45" cy="45" r="44" fill="none" stroke="url(#hubChrome)" strokeWidth="5" />
                <circle cx="45" cy="45" r="39" fill="url(#hubSphere)" />
                <circle cx="45" cy="45" r="39" fill="url(#hubRim)" />
                <ellipse cx="36" cy="32" rx="18" ry="14" fill="url(#hubSpec)" />
              </svg>
              <button
                type="button"
                onClick={screen === 'spinning' ? stopWheel : undefined}
                disabled={screen !== 'spinning'}
                className={`absolute inset-0 rounded-full flex items-center justify-center transition-all duration-200 ${
                  screen === 'spinning' ? 'hover:scale-110 active:scale-90 cursor-pointer' : 'cursor-default'
                }`}
              >
                <span className={`font-black text-base sm:text-lg tracking-wider transition-opacity duration-300 ${screen !== 'spinning' ? 'opacity-40' : ''}`} style={{
                  background: 'linear-gradient(180deg, #ff9999 0%, #ef4444 40%, #b91c1c 100%)',
                  WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                  filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.9))',
                }}>STOP</span>
              </button>
            </div>
          </div>

          {/* BOTTOM ROW */}
          <div className="flex items-center justify-center mt-2">
            {screen === 'spinning' && (
              <div className="flex items-center justify-center gap-2 text-gray-400 py-1">
                <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
                <span className="font-bold text-sm tracking-wide">Tap STOP to win!</span>
                <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
              </div>
            )}
            {screen === 'stopping' && (
              <div className="flex items-center justify-center gap-2 text-gray-400 py-1">
                <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
                <span className="font-bold text-sm tracking-wide">Slowing down...</span>
                <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
```

**Remove:** The `totalWinnings`, `history`, `showHistory`, `spinsLeft` state variables and all related UI (history section, spins counter, demo reset button). These are no longer needed — each user gets 1 spin and the widget shows "done" after.

**Remove:** The `result` state variable (replaced by `screen === 'result'` + `winSegmentRef`).

- [ ] **Step 3: Verify locally**

Run `npm run dev`. In the browser:
1. Widget should show the ID prompt screen first
2. Enter a valid customer ID (e.g., "2") → wheel starts spinning
3. Tap STOP → wheel decelerates → result overlay appears
4. Tap OK/Claim → "Try Again Tomorrow!" screen
5. Reload → still shows "Try Again Tomorrow!" (localStorage persists)

- [ ] **Step 4: Commit**

```bash
git add components/WheelWidget.jsx app/page.js
git commit -m "feat: integrate server-side spin logic + ID prompt + localStorage"
```

---

## Task 8: Add Vercel Environment Variables + Deploy

- [ ] **Step 1: Add env vars to Vercel**

Go to Vercel dashboard → `wheel-of-fortune` project → Settings → Environment Variables. Add:

| Name | Value |
|------|-------|
| `SUPABASE_URL` | `https://blrrcnrhixckfudiojwe.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | *(the service role key)* |

Leave `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` empty for now.

- [ ] **Step 2: Ensure `.env.local` is gitignored**

Check `.gitignore` contains `.env.local`. If not, add it.

- [ ] **Step 3: Push and deploy**

```bash
git push origin main
```

Vercel auto-deploys on push. Verify at `https://wheel-of-fortune-roan.vercel.app`.

- [ ] **Step 4: Test on production**

1. Visit the deployed URL
2. Enter a valid customer ID
3. Spin → verify result
4. Reload → verify "Try Again Tomorrow!" persists
5. Check Supabase tables for the spin log entry

- [ ] **Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: production deployment adjustments"
git push origin main
```

---

## Summary

| Task | What it does |
|------|-------------|
| 1 | Supabase client + database tables + env vars |
| 2 | 5 algorithms + day-date helper + segment mapping |
| 3 | Rate limiter + Telegram notification stub |
| 4 | `/api/validate` endpoint |
| 5 | `/api/spin` endpoint (core rigged engine) |
| 6 | Client-side browser fingerprint |
| 7 | WheelWidget rewrite (ID prompt, API calls, localStorage, remove demo) |
| 8 | Vercel env vars + deploy + production test |
