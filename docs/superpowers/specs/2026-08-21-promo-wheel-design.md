# Promo wheel — free-play acquisition / re-activation landing pages

Date: 2026-08-21
Status: approved (owner, 2026-08-21)

## Purpose

A standalone, free-to-play wheel that always lands on **50 Aviator Free
Spins**, then pushes the visitor to BwanaBet with one big button. Two
audiences, two domains:

| Domain | Audience | Claim button goes to | Copy |
|---|---|---|---|
| A (new players) | visitors who do not have an account | BwanaBet **registration** via the affiliate link (prefills the promo code) | "Claim your free spins" |
| B (existing) | customers who registered but never deposited; they arrive from a campaign link | BwanaBet **login** page | "Log in to claim" |

No real prizes are paid by this page. For Domain B the bonus is already on
the account; the page exists to create awareness in an engaging way. For
Domain A the affiliate link's promo code drives fulfilment on BwanaBet's
side.

## Requirements (from the owner)

- Wheel with distinct colours; outcomes **K100 · K20 · K50 · 50 Free
  Spins · Lose**.
- Always lands on 50 Free Spins.
- Only one spin per visitor.
- Press SPIN → wheel speeds up → lands.
- Big, flashy "Congratulations" pop-up with a "claim" button.
- Button redirects to BwanaBet (registration with affiliate link prefilled,
  or login), depending on domain.
- Works on mobile and desktop; owner supplies background art per the
  resolution spec below.

## Design

### Hosting and routing

Lives in this repo (`wheel-of-fortune`) as a separate route — shares the
deploy pipeline and telemetry, shares **no runtime state** with the money
wheel. Both promo domains are attached to the existing Vercel project; a
`middleware.js` rewrite maps `/` on a promo hostname to `/promo`. The
money wheel's iframe origin (`*.vercel.app`) is untouched.

`lib/promoConfig.js`:

```js
export const PROMO_SITES = {
  '<domain-a>': {
    audience: 'new',
    destination: '<affiliate registration link>',
    ctaText: 'Claim your free spins',
    subText: 'Register in under a minute — your 50 Aviator free spins are waiting.',
    background: { mobile: '/promo/bg-new-mobile.jpg', desktop: '/promo/bg-new-desktop.jpg' },
  },
  '<domain-b>': {
    audience: 'existing',
    destination: 'https://bwanabet.com/login',
    ctaText: 'Log in to claim',
    subText: 'Your 50 Aviator free spins are already in your account.',
    background: { mobile: '/promo/bg-existing-mobile.jpg', desktop: '/promo/bg-existing-desktop.jpg' },
  },
};
export function resolvePromoSite(hostname) // exact match, else default (Domain A config, marked preview)
```

Domain names, the affiliate link and the login URL are supplied by the
owner; until then the config ships with clearly marked placeholders and
`resolvePromoSite` falls back to the Domain A entry so preview deploys
render.

### Layout and art

Full-viewport page, `background-size: cover`, centre-anchored. Breakpoint:
portrait **or** width < 768 px ⇒ mobile layout and mobile art.

- **Mobile (1080 × 1920 art):** headline top, wheel centred at ≈ 92 vw
  diameter, SPIN button below, small print at the bottom.
- **Desktop (1920 × 1080 art):** wheel in the left 45 % (≈ 600 px),
  headline + copy + SPIN button in the right column.
- Brand colours: yellow `#FEF200`, red `#C50E1F`, navy `#1A1E2E`.

### Wheel

Ten slices — each of the five outcomes appears twice, alternating, so the
wheel reads as full (owner listed five outcomes; a five-slice wheel looks
sparse; trivially reducible to five):

```
index: 0 K100 · 1 K20 · 2 K50 · 3 50 FREE SPINS · 4 LOSE · 5 K100 · 6 K20 · 7 K50 · 8 50 FREE SPINS · 9 LOSE
```

Each outcome has its own colour (K100 gold, K20 navy, K50 red, FREE SPINS
bright yellow with a star burst, LOSE grey). Rendered with a CSS
`conic-gradient` plus positioned labels — no canvas, crisp on every DPR.

**Animation** (mirrors the money wheel's proven three phases, in
`lib/promoSpin.js` as pure functions so it is testable):

1. accelerate 0 → full speed over ~0.9 s;
2. constant spin ~2.2 s;
3. ease-out (cubic) to the target angle over ~3.2 s, with a pointer
   "tick" settle.

**Target** = one of the two FREE SPINS slices (chosen at random) at a
random offset within the slice's middle 70 %, so two spins never look
identical but the pointer is never ambiguous at an edge. `landingAngle()`
is the pure function; a test asserts 1,000 samples all resolve to a FREE
SPINS index.

### One spin per visitor

`localStorage['bb_promo'] = { spunAt: ISO }`, written when SPIN is
pressed. On a revisit with the flag set, the page skips the wheel's idle
state and shows the result popup immediately (the visitor already "won";
the claim button stays one tap away). No fingerprinting, no server check —
the worst-case abuse is extra clicks to the registration page.

### Congratulations popup

Full-screen modal over a dark scrim: confetti burst, "🎉 CONGRATULATIONS!",
"You've won **50 Aviator Free Spins**", a large pulsing yellow button with
`ctaText`, and `subText` beneath. The button is a real `<a href>` (no JS
redirect) so mobile browsers never block it. No close button on Domain A
(the only exit is the claim); Domain B gets a small "Maybe later" link.

### Tracking

`promo_events (id, created_at, host, event, is_mobile, ua)` on the CRM
Supabase project; RLS on, service_role only (same posture as the wheel
tables). The page fires `view`, `spin`, `claim_click` via `sendBeacon` to
`POST /api/promo-event` (rate-limited 30/min per IP, validates `event` ∈
the three values, `host` from the request — never from the body). The
daily digest gains one line per configured domain:
`Promo <host>: V views · S spins · C claims`.

### Telemetry

`/api/promo-event` reports insert failures through `reportError`
(`route: 'promo-event', code: 'insert_failed'`). The page itself reports
nothing — a broken promo page is visible as a drop in `view` events.

### Testing

- `lib/promoSpin.test.mjs` — landing angle always inside a FREE SPINS
  slice; phase timings sum to the declared total; easing is monotonic.
- `lib/promoConfig.test.mjs` — exact-host resolution; unknown host falls
  back to the default; every configured entry has a non-empty destination.
- `lib/promoOnce.test.mjs` — once-per-visitor helper (parse / write / corrupt
  storage tolerated).
- Manual: real phone (portrait), desktop (1440 wide), via Chrome tools:
  spin lands on FREE SPINS, popup renders, button opens the configured
  URL, revisit shows popup directly.

### Out of scope

Real prize payment, login/auth, personalisation, A/B testing, multiple
languages.

### Open inputs from the owner (non-blocking; placeholders until then)

1. Domain A and Domain B names.
2. Affiliate registration link (prefills promo code).
3. Login URL for Domain B (defaults to `https://bwanabet.com/login`).
4. Background art: 1080×1920 and 1920×1080 per domain (see resolution spec
   delivered 2026-08-21 in conversation; summarised in "Layout and art").
