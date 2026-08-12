# Promo Copy + Loss Screen Redesign — Design

**Date:** 2026-08-05
**Status:** Approved for planning

**Goal:** Add two promotional messages to the wheel, and rebuild the loss screen
— the screen ~99.65% of spinners see — so that it does its actual job of
bringing the customer back tomorrow.

---

## 1. Background

Three surfaces are in scope. They live in two different visual contexts, and the
distinction drives every styling decision below.

| Surface | Runs in | Visual language |
| --- | --- | --- |
| Promo bubble | `public/embed.js`, on bwanabet.com | The **host site's** — near-black, electric lemon, sharp corners, matching the site's AI BOT chat popup |
| Spin screen line | `components/WheelWidget.jsx`, in the iframe | The **cabinet's** |
| Loss screen | `components/WheelWidget.jsx`, in the iframe | The **cabinet's** |

The widget interior is an **arcade prize cabinet** — a rounded navy panel framed
by a running border of gold marquee bulbs, a chrome wheel rim, candy-coloured
segments, a glossy domed hub button. Result cards render *inside* that frame,
over the wheel, with the bulbs and gold header still visible around them. New
elements inside the widget must extend that vocabulary, not import another one.

The bubble is the opposite case: it is a guest on BwanaBet's own page, so it
matches the host, specifically the existing chat popup pattern (small dark slate
bubble, ~8px radius, ~12px text, small circular × at the top-right corner,
character beside it).

Full context in `.impeccable.md`.

---

## 2. The promo bubble

### Copy

> **CONGRATULATIONS! YOU GET FREE BONUS!**

Verbatim, in capitals, as specified by the owner.

*Recorded for the record:* this fires **before** the spin, so roughly 996 of
every 1,000 readers are congratulated on a bonus and then shown a losing result
seconds later. This was raised twice during design and the wording was
reaffirmed both times. It is the owner's decision and is implemented as written.
Changing it later is a one-line edit to a single constant.

### Behaviour

| Property | Value | Reason |
| --- | --- | --- |
| Trigger | 1.5s after the trigger button becomes visible | The button only appears once a spin is confirmed available, so the bubble can never advertise a spin the customer does not have |
| Auto-hide | 12s | Long enough to read twice on a slow phone; short enough not to camp on the host page |
| Dismiss | Small circular × | Matches the host chat popup |
| Dismissal memory | `localStorage`, keyed **by customer id + wheel-day** | Same account-scoped pattern as `bwanabet_wheel_spun`; a dismissal by one customer on a shared shop PC must not suppress it for the next |
| Re-show | Never again that wheel-day for that account | |
| Position | Anchored above the trigger button, right-aligned, tail pointing down at it | The button is `right:16px; top:50%` |
| z-index | `9997` | Below the button (`9998`) and overlay (`9999`), so it can never cover them |

### Constraints

- **No web fonts.** `embed.js` is dependency-free on a third-party page. Use a
  condensed system stack; the host site's own font is Roboto Condensed, which is
  already loaded there and will be inherited where available.
- **Never break the host page.** Every DOM operation wrapped in `try/catch`, as
  with the existing code.
- **Must fit 320px.** Max width `min(210px, calc(100vw - 88px))`.
- **Hidden whenever the button is hidden** — including when the widget reports
  unavailable, on logout, and on account switch.

---

## 3. The spin screen line

### Copy

> **WIN CASH EVERYDAY WHEN YOU DEPOSIT!**

Verbatim, as specified.

*Recorded:* "everyday" as one word is an adjective (*everyday clothes*); "each
day" is two words, "every day". Flagged during design; implemented as written.
The string lives in one constant, so flipping it is a one-word edit.

### Placement

Below the wheel, above a hairline rule, inside the cabinet. This is read while
the wheel is still turning — the one moment in the flow where the customer is
looking at the screen with nothing to do. Above the wheel it would fight the
gold header; over the wheel it would obscure the prize segments.

Emphasis: the two words carrying the promise take the cabinet's gold. The rest
is white. Gold is not used for the whole line, because gold reads as prize money
throughout this product and must stay scarce.

---

## 4. The loss screen

Replaces the current card, which reads:

```
BETTER LUCK NEXT TIME
TRY AGAIN TOMORROW
[ GOT IT ]
```

Two stock phrases saying the same thing, then a dead-end button.

### New structure — "headline leads" (option A)

Exactly three elements:

1. **Headline** — `NOT THIS TIME`, white, heavy, ~24px
2. **Countdown strip** — label `NEXT FREE SPIN`, then hours and minutes in gold
3. **Button** — `SEE YOU TOMORROW`, domed, grey

Explicitly **not** included, all cut for length: a "today's spin · used"
kicker (the headline says it), a "the wheel resets at 06:00" sentence (the clock
says it), and a repeat of the deposit line (it is already on the spin screen;
repeating it straight after a loss is a hard sell).

### The countdown strip

The one genuinely new visual element. It is built from the **marquee bulb
rhythm of the cabinet border** — a 3px dotted bulb run along its top and bottom
edge — so it reads as part of the machine rather than as an imported component.

- **Hours and minutes only, no seconds.** Ticking seconds on a fourteen-hour
  wait is visual noise and forces a re-render every second for nothing.
- Refreshes on the minute.
- Counts down to the next 04:00 UTC (06:00 CAT) boundary.

### Colour discipline

Gold appears exactly twice on this card: the strip's bulbs, and the countdown
digits. No gold headline, no gold button.

Gold is prize money everywhere else in this product. The countdown is the only
thing on a losing screen that leads to money, so it is the only thing that earns
the colour. A gold headline or a bright primary button would be celebrating a
loss.

The button is domed to echo the glossy hub button at the centre of the wheel,
but grey rather than gold — part of the same machine, without pretending
something good happened.

---

## 5. Components

| Unit | Type | Responsibility |
| --- | --- | --- |
| `lib/countdown.js` | New, pure | `msUntilNextWheelReset(nowMs)` and `formatCountdown(ms)` → `{hours, minutes}`. No DOM, no clock reads. |
| `lib/countdown.test.mjs` | New | Boundary tests: just after reset, one minute before, across a month end, exactly at reset. |
| `components/WheelWidget.jsx` | Modify | Loss card rebuilt; countdown strip; deposit line under the wheel. |
| `public/embed.js` | Modify | Promo bubble: build, position, timers, dismissal, account-scoped storage. |

All timing logic is pure and unit-tested. The React component holds only a
`useEffect` interval that re-reads the pure function each minute; the bubble in
`embed.js` holds only `setTimeout` calls.

---

## 6. Testing

- **Unit** (`node --test`): the countdown helpers, including the reset boundary
  and month-end rollover. Current baseline is 101 passing tests.
- **Manual, local** (`npm run dev`, `?test=1`): spin to a loss, confirm the card
  renders inside the cabinet, confirm the countdown shows a plausible time and
  advances on the minute, confirm at 320px width.
- **Manual, bubble**: `public/test.html` with `?wheelDebug=1`; confirm the
  bubble appears 1.5s after the button, auto-hides at 12s, that × dismisses it,
  and that after dismissal it does not return on reload for the same account but
  does for a different one.

No load testing. The production database is shared with the CRM.

---

## 7. Out of scope

- Restyling the win screen, prompt screen or wheel itself.
- Any change to spin, cooldown, deposit-gate or carry-over logic.
- The stranded-carry-over alert and the duplicate-Vercel-project cleanup, both
  tracked separately.
