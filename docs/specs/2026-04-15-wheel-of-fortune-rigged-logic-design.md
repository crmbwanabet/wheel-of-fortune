# Wheel of Fortune — Rigged Logic Design

**Date:** 2026-04-15
**Repo:** `crmbwanabet/wheel-of-fortune` (Next.js standalone widget)
**Database:** Supabase (`blrrcnrhixckfudiojwe`)
**Deployed at:** `https://wheel-of-fortune-roan.vercel.app`

---

## 1. Overview

The Wheel of Fortune widget is a standalone Next.js app embedded via iframe on bwanabet.com (mobile only). It currently picks winners randomly on the client side. This spec adds server-side rigged logic so that exactly 100 out of every ~10,000 daily spins win, with a fixed K2,000 daily prize budget, distributed across 5 rotating algorithms.

## 2. Core Rules

| Rule | Value |
|------|-------|
| Daily prize budget | K2,000 |
| Daily winning spins | 100 |
| Spins per user per day | 1 |
| Daily reset time | 06:00 AM (Zambia time, CAT/UTC+2) |
| Spin volume cap | Uncapped — if <10,000 spins, unused wins expire. If >10,000, extra spins lose |
| Win decision | Server-side only — client never knows the logic |

## 3. User Flow

1. Widget loads inside bwanabet.com iframe (mobile only — bwanabet developer handles device restriction)
2. Widget checks browser localStorage — if user already spun today (since 6am), show "Try Again Tomorrow!" immediately
3. If eligible, show a **User ID input prompt** — user types their bwanabet customer ID
4. Widget calls `/api/validate` with the entered ID
5. API checks `customers` table in Supabase (`id` column, ~91K records) — if ID not found, reject with error
6. If valid, widget calls `/api/spin` with the customer ID + browser fingerprint
7. API checks:
   - Has this customer ID already spun today? If yes, reject
   - Has this browser fingerprint already spun today? If yes, reject (secondary check)
8. API increments global spin counter and checks if this spin number is in today's winning list
9. Returns `{ win: true/false, segmentIndex: <number>, prize: <object|null> }`
10. Widget animates the wheel to land on the returned segment
11. After spin, widget stores spin in localStorage and shows "Try Again Tomorrow!" until 6am reset

## 4. Prize Segments

The wheel has 10 segments (unchanged from current):

| Segment | Label | Prize | Color |
|---------|-------|-------|-------|
| 1 | K10 | `{ kwacha: 10 }` | `#06b6d4` |
| 2 | Try Again Tomorrow | `null` | `#374151` |
| 3 | K50 | `{ kwacha: 50 }` | `#a855f7` |
| 4 | Try Again Tomorrow | `null` | `#4b5563` |
| 5 | K200 | `{ kwacha: 200 }` | `#eab308` |
| 6 | Try Again Tomorrow | `null` | `#374151` |
| 7 | K20 | `{ kwacha: 20 }` | `#22c55e` |
| 8 | Try Again Tomorrow | `null` | `#4b5563` |
| 9 | K100 | `{ kwacha: 100 }` | `#f97316` |
| 10 | Try Again Tomorrow | `null` | `#374151` |

- Winning spins land on a prize segment (K10/K20/K50/K100/K200)
- Losing spins land on any "Try Again Tomorrow" segment (randomly chosen)

## 5. Algorithms

Five prize distribution profiles, each totaling exactly K2,000 across exactly 100 wins:

| # | Style | K10 | K20 | K50 | K100 | K200 | Total | Verification |
|---|-------|-----|-----|-----|------|------|-------|--------------|
| 1 | Drizzle | 55 | 35 | 7 | 2 | 1 | K2,000 | 550+700+350+200+200 |
| 2 | Balanced | 75 | 15 | 5 | 3 | 2 | K2,000 | 750+300+250+300+400 |
| 3 | K50-heavy | 78 | 6 | 12 | 3 | 1 | K2,000 | 780+120+600+300+200 |
| 4 | Top-heavy | 89 | 3 | 1 | 4 | 3 | K2,000 | 890+60+50+400+600 |
| 5 | K20-heavy | 43 | 51 | 3 | 2 | 1 | K2,000 | 430+1020+150+200+200 |

### Algorithm Selection Weights

| Algorithm | Weight | Probability |
|-----------|--------|-------------|
| 1 — Drizzle | 2 | ~22% |
| 2 — Balanced | 2 | ~22% |
| 3 — K50-heavy | 2 | ~22% |
| 4 — Top-heavy | 1 | ~11% |
| 5 — K20-heavy | 2 | ~22% |

Selection pool: `[1, 1, 2, 2, 3, 3, 4, 5, 5]` — pick randomly each day.

### Daily Initialization (Lazy)

On the first spin of each new day (after 6am):

1. Pick an algorithm from the weighted pool
2. Generate 100 random, unique spin positions between 1 and 10,000
3. Shuffle the algorithm's prize pool (e.g., 55 K10s + 35 K20s + 7 K50s + 2 K100s + 1 K200 for algo 1)
4. Assign each prize to a winning position
5. Store everything in `wheel_daily_state` table
6. This happens atomically — if two spins race, only one initializes

## 6. Database Schema

All tables live in the existing Supabase project (`blrrcnrhixckfudiojwe`). User validation queries the existing `customers` table.

### Table: `wheel_daily_state`

Stores the current day's algorithm and prize assignments. One row per day.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid (PK) | Auto-generated |
| `day_date` | date (unique) | The day this state is for (based on 6am reset) |
| `algorithm_id` | int | Which algorithm (1-5) was selected |
| `winning_positions` | jsonb | Map of spin position -> prize, e.g. `{"47": 10, "203": 50, "891": 200, ...}` |
| `total_spins` | int | Running count of spins today |
| `total_wins` | int | Running count of wins awarded today |
| `total_budget_spent` | int | Running total of prize money awarded (K) |
| `created_at` | timestamptz | When this day was initialized |

### Table: `wheel_spin_log`

Every spin is logged.

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid (PK) | Auto-generated |
| `day_date` | date | Which day (6am-based) |
| `customer_id` | text | Customer ID from `customers.id` |
| `spin_number` | int | This spin's position in the day's sequence |
| `won` | boolean | Whether this spin was a winner |
| `prize_amount` | int | Prize value (0 if loss) |
| `segment_index` | int | Which wheel segment was returned (0-9) |
| `fingerprint` | text | Browser fingerprint hash |
| `ip_address` | text | Request IP |
| `created_at` | timestamptz | Timestamp |

## 7. API Endpoints

All endpoints are Next.js API routes in the `wheel-of-fortune` repo.

### `POST /api/validate`

Validates a customer ID exists in the CRM.

**Request:** `{ "customerId": "12345" }`

**Logic:**
1. Query `customers` table where `id = customerId`
2. If found, return `{ valid: true }`
3. If not found, return `{ valid: false, error: "Invalid ID" }`

### `POST /api/spin`

The core spin endpoint. Decides win/lose and returns the segment.

**Request:** `{ "customerId": "12345", "fingerprint": "abc123hash" }`

**Logic:**
1. Calculate current "day" based on 6am CAT (UTC+2) reset — `day_date = today` if current time >= 6am CAT, else `day_date = yesterday`
2. Check `wheel_spin_log` — has this `customerId` spun today? If yes, reject: `{ error: "already_spun" }`
3. Check `wheel_spin_log` — has this `fingerprint` spun today? If yes, reject: `{ error: "already_spun" }`
4. Load or lazily initialize `wheel_daily_state` for today
5. Atomically increment `total_spins` and get the new spin number
6. Check if spin number exists in `winning_positions`:
   - **Win:** Get prize amount, pick corresponding prize segment index, increment `total_wins` and `total_budget_spent`
   - **Lose:** Pick a random "Try Again Tomorrow" segment index from `[1, 3, 5, 7, 9]` (0-indexed positions of the 5 loss segments)
7. Log to `wheel_spin_log`
8. Return: `{ win: true/false, segmentIndex: <number>, prize: { kwacha: <amount> } | null }`

### Rate Limiting

- Max 5 requests per minute per IP across all endpoints
- Implemented via in-memory rate limiter or Supabase-based counter

## 8. Anti-Cheat Layers

| Layer | What it prevents |
|-------|-----------------|
| Server-side win decision | Client cannot manipulate outcomes |
| 1 spin per customer ID per day | Same user cannot spin twice |
| Browser fingerprint check | Same device cannot spin under multiple IDs |
| Rate limiting (5 req/min/IP) | Scripted brute-force attacks |
| Customer ID validation against CRM | Random/fake IDs are rejected |
| localStorage check (client-side) | Quick UX block — prevents unnecessary API calls |
| Winning positions never exposed | Spin counter and position map are server-only |
| Budget guard | Atomic check before awarding — prevents overshoot on concurrent requests |

## 9. Telegram Integration (Placeholder)

When a user wins, the API will call a `sendTelegramNotification` function. For now, this is a no-op stub that logs the win data. When ready to wire up:

1. Create a Telegram bot via @BotFather
2. Get the bot token and admin group chat ID
3. Add them as environment variables
4. The stub sends a message:

```
Win Notification:
User ID: {customerId}
Prize: K{amount}
Time: {timestamp}
Daily: {winsToday}/100 wins | K{spentToday}/K2,000 budget
```

## 10. Client-Side Changes

The existing `WheelWidget.jsx` needs these modifications:

1. **Add User ID prompt screen** — input field + "Play" button, shown before the wheel
2. **Call `/api/validate`** when user submits their ID
3. **Call `/api/spin`** instead of local `Math.random()` when STOP is pressed
4. **Animate to server-returned segment** — the `segmentIndex` from the API determines where the wheel lands
5. **Show "Try Again Tomorrow!"** after any spin (win or lose) and store in localStorage
6. **localStorage reset logic** — check against 6am daily reset, not midnight
7. **Add browser fingerprinting** — generate a fingerprint hash from available browser signals (canvas, screen, user agent, etc.)
8. **Remove demo reset button** — no more unlimited spins

## 11. Environment Variables

Required in the `wheel-of-fortune` Vercel project:

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | `https://blrrcnrhixckfudiojwe.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | (the service role key) |
| `TELEGRAM_BOT_TOKEN` | (to be added later) |
| `TELEGRAM_CHAT_ID` | (to be added later) |

## 12. Deployment

- Same Vercel project: `wheel-of-fortune-roan.vercel.app`
- Same iframe embed code on bwanabet.com (no changes needed from bwanabet developer for the logic — only the existing `showBwanaBetWheel(userId)` call)
- Note: the `userId` param in the URL is now optional — the widget has its own ID prompt. The URL param can pre-fill the input if provided.
