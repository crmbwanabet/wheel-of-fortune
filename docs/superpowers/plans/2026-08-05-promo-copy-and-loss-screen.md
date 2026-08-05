# Promo Copy + Loss Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a promo bubble on the host page and a deposit line on the spin screen, and rebuild the loss screen around a live countdown to the next free spin.

**Architecture:** All timing logic lands in one new pure module (`lib/countdown.js`) built on the already-tested `previousWheelDayWindowUtc`, so nothing new reads the clock directly. `WheelWidget.jsx` gains a one-minute interval that re-reads that pure function. `embed.js` gains a self-contained bubble built with the same defensive, dependency-free ES5 style as the rest of that file.

**Tech Stack:** Next.js 14 (App Router, JS not TS), Tailwind utility classes plus inline styles in `WheelWidget.jsx`, vanilla ES5 in `public/embed.js`, `node --test` with `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-05-promo-copy-and-loss-screen-design.md`

---

## Background you need before starting

**The wheel-day.** Resets 06:00 CAT = 04:00 UTC. `previousWheelDayWindowUtc(nowMs)` in `lib/wheelTime.js` already returns `{ prevStartMs, curStartMs }`, where `curStartMs` is 04:00 UTC of the **current** wheel-day. The next reset is therefore always `curStartMs + 86400000`. Reuse it; do not write new date maths.

**Two visual contexts.** `public/embed.js` runs on bwanabet.com and must match the host site (near-black, electric lemon `#fff100`, sharp corners, the chat-popup bubble pattern). Everything inside `components/WheelWidget.jsx` lives in the arcade cabinet (navy panel, gold marquee bulbs, chrome, gold `#ffd700`). Do not mix them. See `.impeccable.md`.

**Module format.** `package.json` has no `"type": "module"`. Files in `lib/` use ESM anyway; Node reparses with a warning and tests pass. Implementation in `.js`, tests in `.test.mjs`.

**Test command.** `npm test` runs `node --test lib/*.test.mjs`. Baseline is **101 passing tests**.

**Copy is verbatim and deliberate.** `CONGRATULATIONS! YOU GET FREE BONUS!` and `WIN CASH EVERYDAY WHEN YOU DEPOSIT!` are the owner's exact words, confirmed twice. Do not "fix" them.

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `lib/countdown.js` | Create | Pure: ms until next reset, and ms → `{hours, minutes}`. |
| `lib/countdown.test.mjs` | Create | Boundary tests for both functions. |
| `components/WheelWidget.jsx` | Modify | Loss card rebuild + countdown strip + deposit line. |
| `public/embed.js` | Modify | Promo bubble. |

---

## Task 1: Countdown helpers

**Files:**
- Create: `lib/countdown.js`
- Test: `lib/countdown.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `lib/countdown.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msUntilNextWheelReset, splitCountdown } from './countdown.js';

const at = (iso) => Date.parse(iso);
const HOUR = 3600_000;

// The wheel resets at 04:00 UTC (06:00 CAT). The countdown always points at the
// NEXT reset, so it is > 0 and <= 24h at every instant.

test('mid-morning, the next reset is later the same UTC day plus one', () => {
  assert.equal(msUntilNextWheelReset(at('2026-08-05T10:00:00Z')), 18 * HOUR);
});

test('just before the reset, only minutes remain', () => {
  assert.equal(msUntilNextWheelReset(at('2026-08-05T03:59:00Z')), 60_000);
});

test('exactly at the reset, a full day remains', () => {
  assert.equal(msUntilNextWheelReset(at('2026-08-05T04:00:00Z')), 24 * HOUR);
});

test('one minute after the reset, just under a full day remains', () => {
  assert.equal(msUntilNextWheelReset(at('2026-08-05T04:01:00Z')), 24 * HOUR - 60_000);
});

test('the window rolls across a month boundary', () => {
  assert.equal(msUntilNextWheelReset(at('2026-07-31T23:00:00Z')), 5 * HOUR);
});

test('the result is always within (0, 24h]', () => {
  for (const iso of ['2026-01-01T00:00:00Z', '2026-02-28T04:00:00Z', '2026-12-31T23:59:00Z']) {
    const ms = msUntilNextWheelReset(at(iso));
    assert.ok(ms > 0 && ms <= 24 * HOUR, `${iso} gave ${ms}`);
  }
});

test('splitCountdown breaks milliseconds into whole hours and minutes', () => {
  assert.deepEqual(splitCountdown(14 * HOUR + 32 * 60_000), { hours: 14, minutes: 32 });
});

test('splitCountdown floors seconds away rather than rounding up', () => {
  assert.deepEqual(splitCountdown(59_999), { hours: 0, minutes: 0 });
});

test('splitCountdown clamps a negative to zero', () => {
  // A device clock running ahead can produce this. It must render 0h 0m, never
  // a negative or NaN.
  assert.deepEqual(splitCountdown(-5000), { hours: 0, minutes: 0 });
});

test('splitCountdown clamps junk to zero', () => {
  assert.deepEqual(splitCountdown(NaN), { hours: 0, minutes: 0 });
  assert.deepEqual(splitCountdown(undefined), { hours: 0, minutes: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/countdown.test.mjs`
Expected: FAIL — `Cannot find module ... countdown.js`

- [ ] **Step 3: Write minimal implementation**

Create `lib/countdown.js`:

```javascript
// Countdown to the next free spin.
//
// The wheel-day resets at 06:00 CAT = 04:00 UTC. previousWheelDayWindowUtc
// already returns curStartMs — 04:00 UTC of the CURRENT wheel-day — so the next
// reset is always exactly one day after it. Reusing that helper keeps every
// wheel-day boundary in this codebase governed by one tested implementation.

import { previousWheelDayWindowUtc } from './wheelTime.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Milliseconds until the next 04:00 UTC boundary. Always in (0, DAY_MS].
export function msUntilNextWheelReset(nowMs) {
  const { curStartMs } = previousWheelDayWindowUtc(nowMs);
  return curStartMs + DAY_MS - nowMs;
}

// Whole hours and minutes. Clamps to zero rather than ever rendering a negative
// or NaN: a device clock running ahead of real time is common enough that the
// widget already has diagnostics for it, and "-1h -3m" on a losing screen would
// look broken to the customer.
export function splitCountdown(ms) {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return {
    hours: Math.floor(safe / 3600_000),
    minutes: Math.floor((safe % 3600_000) / 60_000),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test lib/countdown.test.mjs`
Expected: PASS, 10 tests

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: `pass 111`, `fail 0` (101 baseline + 10)

- [ ] **Step 6: Commit**

```bash
git add lib/countdown.js lib/countdown.test.mjs
git commit -m "feat(wheel): countdown helper for the next free spin"
```

---

## Task 2: Loss screen rebuild

**Files:**
- Modify: `components/WheelWidget.jsx`

- [ ] **Step 1: Import the helpers**

After the `decideAvailability` import near the top, add:

```javascript
import { msUntilNextWheelReset, splitCountdown } from '@/lib/countdown';
```

- [ ] **Step 2: Add the countdown state and interval**

Immediately after the `const [prizeFlash, setPrizeFlash] = useState(false);` declaration (or the last `useState` in that block), add:

```javascript
  // Countdown to the next free spin, shown on the loss and done cards.
  // Minutes only — seconds on a 14-hour wait are noise and would re-render
  // every second for nothing. Recomputed on the minute from a pure function.
  const [resetIn, setResetIn] = useState(() => splitCountdown(msUntilNextWheelReset(Date.now())));
  useEffect(() => {
    const tick = () => setResetIn(splitCountdown(msUntilNextWheelReset(Date.now())));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);
```

- [ ] **Step 3: Replace the loss branch of the result overlay**

In the result overlay, replace this block:

```jsx
                <div className="text-lg font-extrabold uppercase tracking-widest mb-2" style={{ color: 'rgba(255,255,255,0.7)', letterSpacing: '2px' }}>
                  BETTER LUCK NEXT TIME
                </div>
                <div className="text-base font-bold uppercase tracking-widest mb-6" style={{ color: 'rgba(255,255,255,0.4)', letterSpacing: '2px' }}>
                  TRY AGAIN TOMORROW
                </div>
```

with:

```jsx
                <div className="font-black uppercase mb-4" style={{ color: '#fff', fontSize: '24px', letterSpacing: '-0.01em', lineHeight: 1 }}>
                  NOT THIS TIME
                </div>
                {/* Countdown strip. The bulb runs on its top and bottom edge are
                    the same rhythm as the cabinet border, so the one new element
                    on this card is built from the widget's own vocabulary. */}
                <div className="relative mb-5" style={{
                  background: '#12151f', border: '1px solid #333a4d', borderRadius: '8px', padding: '12px 9px 10px',
                }}>
                  <div style={{ position: 'absolute', left: 7, right: 7, top: 4, height: 3,
                    background: 'repeating-linear-gradient(90deg,#ffd24a 0 3px,transparent 3px 11px)',
                    filter: 'drop-shadow(0 0 3px rgba(255,210,74,0.6))' }} />
                  <div style={{ position: 'absolute', left: 7, right: 7, bottom: 4, height: 3,
                    background: 'repeating-linear-gradient(90deg,#ffd24a 0 3px,transparent 3px 11px)',
                    filter: 'drop-shadow(0 0 3px rgba(255,210,74,0.6))' }} />
                  <div className="uppercase" style={{ fontSize: '8px', fontWeight: 700, letterSpacing: '0.19em', color: '#8e93a3' }}>
                    NEXT FREE SPIN
                  </div>
                  <div style={{ fontWeight: 900, fontSize: '25px', color: '#ffd700', letterSpacing: '0.03em',
                    lineHeight: 1.05, fontVariantNumeric: 'tabular-nums', textShadow: '0 0 14px rgba(255,215,0,0.35)' }}>
                    {resetIn.hours}<small style={{ fontSize: '11px', color: '#8e93a3', fontWeight: 700 }}>h</small>{' '}
                    {String(resetIn.minutes).padStart(2, '0')}<small style={{ fontSize: '11px', color: '#8e93a3', fontWeight: 700 }}>m</small>
                  </div>
                </div>
```

- [ ] **Step 4: Change the loss button label and style**

In the same overlay, replace the button's loss-side class string:

```jsx
                  ? 'bg-gradient-to-r from-gray-500 to-gray-600 hover:from-gray-600 hover:to-gray-700 shadow-gray-500/20'
```

with:

```jsx
                  ? 'hover:brightness-110'
```

and replace the loss-side style object `{}`:

```jsx
              style={spinResult.isLoss ? {} : { '--btn-shadow': '#065F46', '--btn-glow': 'rgba(16,185,129,0.3)', '--btn-glow2': 'rgba(16,185,129,0.15)', animation: 'collectBtnPulse 2s ease-in-out infinite' }}
```

with:

```jsx
              style={spinResult.isLoss ? {
                // Domed like the wheel's hub button so it reads as part of the
                // same machine, but grey — a gold button would be celebrating a loss.
                background: 'linear-gradient(180deg,#454b63,#2a2f42)',
                border: '1px solid #555c76',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.16), 0 3px 9px rgba(0,0,0,0.45)',
              } : { '--btn-shadow': '#065F46', '--btn-glow': 'rgba(16,185,129,0.3)', '--btn-glow2': 'rgba(16,185,129,0.15)', animation: 'collectBtnPulse 2s ease-in-out infinite' }}
```

and the label:

```jsx
              {spinResult.isLoss ? 'GOT IT' : 'Claim Prize!'}
```

becomes:

```jsx
              {spinResult.isLoss ? 'SEE YOU TOMORROW' : 'Claim Prize!'}
```

- [ ] **Step 5: Verify the build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add components/WheelWidget.jsx
git commit -m "feat(wheel): rebuild the loss screen around a countdown to the next spin"
```

---

## Task 3: Deposit line on the spin screen

**Files:**
- Modify: `components/WheelWidget.jsx`

- [ ] **Step 1: Add the line below the wheel**

Find the end of the wheel block — the `</div>` that closes the wheel container, immediately before the final three closing `</div>`s of the component (around line 1316). Insert directly after that closing tag:

```jsx
          {/* House promo. Read while the wheel is still turning — the one
              moment the customer is looking at the screen with nothing to do.
              Gold on the two words carrying the promise only; a fully gold line
              would compete with the prize segments and devalue the colour. */}
          <div className="text-center" style={{ borderTop: '1px solid #3a3f52', marginTop: '14px', paddingTop: '13px' }}>
            <div className="font-black uppercase" style={{ fontSize: '15px', color: '#fff', lineHeight: 1.2, letterSpacing: '0.01em' }}>
              WIN CASH <span style={{ color: '#ffd700' }}>EVERYDAY</span><br />WHEN YOU DEPOSIT!
            </div>
          </div>
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Verify visually**

Run `npm run dev`, open `http://localhost:3000/?test=1`, click Play. Confirm the line sits under the wheel inside the cabinet, does not overlap the wheel, and wraps to two lines at 320px width.

- [ ] **Step 4: Commit**

```bash
git add components/WheelWidget.jsx
git commit -m "feat(wheel): deposit promo line under the wheel"
```

---

## Task 4: Promo bubble in embed.js

**Files:**
- Modify: `public/embed.js`

- [ ] **Step 1: Add the constants**

After the `var READY_TIMEOUT_MS = 15000;` block, add:

```javascript
  // Promo bubble shown above the trigger button. Styled to match the host
  // site's own chat popup (small dark slate bubble, ~8px radius, ~12px text,
  // circular close on the corner) rather than the wheel's arcade cabinet —
  // this element lives on BwanaBet's page, not inside our iframe.
  var PROMO_TEXT = 'CONGRATULATIONS! YOU GET FREE BONUS!';
  var PROMO_DELAY_MS = 1500;   // after the button appears
  var PROMO_VISIBLE_MS = 12000;
  var PROMO_KEY = 'bwanabet_wheel_promo';
```

- [ ] **Step 2: Add account-scoped dismissal storage**

After the `markReported()` function, add:

```javascript
  // Dismissal is remembered per ACCOUNT per wheel-day, not per device: on a
  // shared shop PC one customer dismissing the bubble must not suppress it for
  // the next person to log in. Mirrors the bwanabet_wheel_spun map shape.
  function promoDismissed(id) {
    if (!id) return false;
    try {
      var map = JSON.parse(localStorage.getItem(PROMO_KEY) || '{}');
      return map && map[id] === getWheelDay();
    } catch (e) { return false; }
  }
  function markPromoDismissed(id) {
    if (!id) return;
    try {
      var map = {};
      try { map = JSON.parse(localStorage.getItem(PROMO_KEY) || '{}') || {}; } catch (e) { map = {}; }
      var today = getWheelDay();
      var next = {};
      for (var k in map) { if (map[k] === today) next[k] = map[k]; }  // prune old days
      next[id] = today;
      localStorage.setItem(PROMO_KEY, JSON.stringify(next));
    } catch (e) { /* ignore */ }
  }
```

- [ ] **Step 3: Build the bubble inside initWidget**

Inside `initWidget`, immediately after the trigger button's `document.body.appendChild(btn);` line, add:

```javascript
    // --- Promo bubble ---------------------------------------------------
    var promo = document.createElement('div');
    promo.id = 'bwanabet-wheel-promo';
    promo.style.cssText = 'position:fixed;right:14px;z-index:9997;display:none;' +
      'width:min(210px,calc(100vw - 88px));box-sizing:border-box;' +
      'background:#2b3140;color:#fff;border-radius:8px;padding:11px 13px 12px;' +
      'font-family:"Roboto Condensed",Arial,sans-serif;font-size:12px;font-weight:700;' +
      'line-height:1.34;letter-spacing:.01em;box-shadow:0 6px 20px rgba(0,0,0,.55);' +
      'opacity:0;transition:opacity .25s ease-out,transform .25s ease-out;transform:translateY(6px);';
    promo.innerHTML =
      '<span style="position:absolute;top:-7px;right:-7px;width:18px;height:18px;border-radius:50%;' +
      'background:#4a5162;color:#fff;font-size:11px;line-height:18px;text-align:center;font-weight:700;' +
      'cursor:pointer" data-promo-close="1">&times;</span>' +
      '<span style="color:#fff100">' + PROMO_TEXT + '</span>' +
      '<span style="position:absolute;right:24px;bottom:-7px;width:14px;height:8px;background:#2b3140;' +
      'clip-path:polygon(0 0,100% 0,50% 100%)"></span>';
    document.body.appendChild(promo);

    var promoShowTimer = null, promoHideTimer = null;

    function positionPromo() {
      // Anchor above the button. The button is 64px tall, centred vertically.
      try {
        var r = btn.getBoundingClientRect();
        promo.style.bottom = (window.innerHeight - r.top + 10) + 'px';
      } catch (e) { promo.style.bottom = '55%'; }
    }
    function hidePromo() {
      if (promoShowTimer) { clearTimeout(promoShowTimer); promoShowTimer = null; }
      if (promoHideTimer) { clearTimeout(promoHideTimer); promoHideTimer = null; }
      promo.style.opacity = '0';
      promo.style.transform = 'translateY(6px)';
      promo.style.display = 'none';
    }
    function showPromoSoon() {
      if (promoDismissed(activeCustomerId)) { dbg('promo already dismissed today for', activeCustomerId); return; }
      if (promoShowTimer) return;
      promoShowTimer = setTimeout(function () {
        promoShowTimer = null;
        if (btn.style.display === 'none') return;   // button hidden in the meantime
        positionPromo();
        promo.style.display = 'block';
        // Force a reflow so the transition runs from the hidden state.
        void promo.offsetHeight;
        promo.style.opacity = '1';
        promo.style.transform = 'translateY(0)';
        dbg('promo bubble shown');
        promoHideTimer = setTimeout(hidePromo, PROMO_VISIBLE_MS);
      }, PROMO_DELAY_MS);
    }

    promo.addEventListener('click', function (e) {
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-promo-close')) {
        markPromoDismissed(activeCustomerId);
        dbg('promo dismissed by', activeCustomerId);
        hidePromo();
        return;
      }
      hidePromo();
      openWidget();
    });
    window.addEventListener('resize', function () {
      if (promo.style.display === 'block') positionPromo();
    });
```

- [ ] **Step 4: Show it when the button appears, hide it when the button hides**

Replace:

```javascript
        if (e.data.available) {
          btn.style.display = 'flex';
        } else {
```

with:

```javascript
        if (e.data.available) {
          btn.style.display = 'flex';
          showPromoSoon();
        } else {
```

And in `hideButton`, replace:

```javascript
    function hideButton() {
      btn.style.display = 'none';
```

with:

```javascript
    function hideButton() {
      btn.style.display = 'none';
      hidePromo();
```

- [ ] **Step 5: Verify locally**

Run `npm run dev`, open `http://localhost:3000/test.html?wheelDebug=1`. The local harness has no BwanaBet session, so the trigger button will not appear — confirm instead that the page still loads with no console errors and that `[wheel]` diagnostic lines print. Then in the console run:

```javascript
document.getElementById('bwanabet-wheel-promo')
```

Expected: the element exists (proving it was built without throwing).

- [ ] **Step 6: Commit**

```bash
git add public/embed.js
git commit -m "feat(embed): promo bubble above the wheel trigger button"
```

---

## Task 5: Final verification

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: `pass 111`, `fail 0`

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: succeeds, no errors.

- [ ] **Step 3: Visual check of the loss screen**

Run `npm run dev`, open `http://localhost:3000/?test=1`, click Play, click STOP, wait for the wheel to stop. Confirm:
- the card shows `NOT THIS TIME`, the bulb-edged countdown strip, and `SEE YOU TOMORROW` — three elements, nothing else
- the countdown reads a plausible hours/minutes value
- gold appears only on the bulbs and the digits
- the card sits inside the cabinet with the marquee border still visible

- [ ] **Step 4: Push**

```bash
git push origin main
```

Vercel deploys `main` automatically. Confirm afterwards that
`https://wheel-of-fortune-roan.vercel.app/embed.js` contains `bwanabet-wheel-promo`.

---

## Out of scope

Win screen, prompt screen and wheel styling are unchanged. No spin, cooldown, deposit-gate or carry-over logic is touched. Do not load-test the shared production database.
