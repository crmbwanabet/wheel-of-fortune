# Wheel of Fortune — UI Animation & Interaction Improvements

**Date:** 2026-04-15
**Repo:** `crmbwanabet/wheel-of-fortune` (Next.js standalone widget)
**Scope:** Animations, interactions, and screen polish only — no wheel visual redesign

---

## 1. Overview

The wheel widget's core visuals (segments, chrome frame, colors, layout) remain unchanged. This spec covers animation quality, pointer-peg physics, screen flow polish, and result screen improvements. No emojis anywhere in the UI.

## 2. Scope

| In Scope | Out of Scope |
|----------|-------------|
| Pointer-peg spring physics | Wheel segment colors/design |
| Flashing STOP button | Chrome frame redesign |
| Smoother deceleration easing | Layout/spacing changes |
| Win celebration sequence | Sound effects |
| Loss screen (no emojis, dignified tone) | New features |
| Prompt screen (wheel behind, white text, no emojis) | Backend changes |

## 3. Flashing STOP Button

During the `spinning` screen state (before STOP is pressed):

- The STOP button text pulses with a glow animation: opacity cycles 0.6 → 1.0, text-shadow pulses from none to a red glow (`0 0 12px rgba(239,68,68,0.6)`)
- Animation: `1s ease-in-out infinite`
- The hub ring around the STOP button also pulses subtly (border glow cycles)
- Once STOP is pressed (screen transitions to `stopping`): animation stops immediately, button returns to its current static appearance (opacity 0.4, no glow, cursor-default)

## 4. Pointer-Peg Physics

### Current State
- 10 gold pegs exist at segment boundaries on the wheel rim (SVG circles)
- Pointer is a gold SVG arrow at the top, has a simple CSS `pointerBounce` animation during spin
- No interaction between pointer and pegs — they are independent

### New Behavior
The pointer becomes a spring-damped physical object that reacts to pegs passing underneath it.

**How it works:**
1. Track the wheel's current rotation angle each frame
2. Calculate when a peg passes the pointer's position (top-center, every 36 degrees)
3. On each peg crossing, apply an impulse to the pointer's angular velocity
4. Pointer rotation is governed by a spring-damper system:
   - `angle += velocity * dt`
   - `velocity += (-stiffness * angle - damping * velocity) * dt`
   - On peg hit: `velocity += impulseStrength`

**Spring parameters:**
- Rest angle: 0 degrees (pointing straight down)
- Max deflection: ~15 degrees
- Stiffness: 300 (snaps back quickly)
- Damping: 12 (bouncy but settles in 3-4 oscillations)
- Impulse strength: scales with wheel speed
  - Full speed (8 deg/frame): impulse = 3 (tiny rapid flicks)
  - Medium speed: impulse = 6 (visible bounces)
  - Near stop: impulse = 10 (big dramatic bounces)

**Implementation:**
- Replace the CSS `pointerBounce` animation with JS-driven `transform: rotate(Xdeg)` on the pointer SVG element
- Use a ref for pointer angle and velocity, updated each rAF frame
- Detect peg crossings by checking when `floor(wheelAngle / 36)` changes between frames
- The pointer SVG pivot point is at its base (top of wheel) — rotation makes the tip swing left/right

### Landing Moment
When the wheel fully stops:
- Pointer may be mid-bounce from the last peg
- Let the spring simulation continue for ~500ms after wheel stops so the pointer settles naturally with diminishing oscillations
- Do NOT abruptly reset pointer angle — let physics settle it

## 5. Smoother Deceleration

### Current State
- Uses `easeOutCubic` over 3.5 seconds
- Total distance calculated to match free-spin speed at start

### Changes
- Switch from `easeOutCubic` to `easeOutQuint`: `1 - Math.pow(1 - t, 5)`
  - This has a softer tail — wheel creeps more gradually at the end, building more anticipation
- Keep duration at 3.5 seconds
- Keep the velocity-matching logic for total distance calculation (derivative of easeOutQuint at t=0 is 5, so: `idealTotal = SPIN_SPEED * 60 * DECEL_DURATION / 5000`)

### Anticipation Cues
- During the last 20% of deceleration (t > 0.8), the "Slowing down..." text fades in below the wheel
- No other changes to the deceleration visuals — the pointer-peg physics naturally create anticipation as bounces get bigger

## 6. Win Celebration

### Current State
- Screen flash, confetti (60 DOM elements), floating numbers, particle emojis
- Result overlay shows emoji icon, "You Won", prize amount, Claim Prize button

### Changes

**Remove all emojis and icons from the result overlay.**
The win screen leads with the prize amount — no badge, no icon, no emoji above it.

**Prize count-up animation:**
- "YOU WON" label in small uppercase gold text (12px, letter-spacing 3px)
- Prize amount counts up from K0 to the final value (e.g., K0 → K200)
- Duration: 800ms, easeOutCubic timing
- Text: large (48px), font-weight 900, gold color (#ffd700), with text-shadow glow
- Text scales up slightly during count (from scale 0.9 to 1.0)
- On reaching final value: brief gold flash behind the number

**Confetti improvements:**
- Keep the 60 DOM element confetti
- Remove emoji particles from the canvas particle system — use colored circles/squares only
- Particle colors: gold (#fbbf24), purple (#a855f7), cyan (#06b6d4), pink (#ec4899), green (#22c55e)

**Screen shake:**
- On win reveal, apply a brief CSS transform shake to the main card:
  - 6 frames, ~150ms total
  - Alternating translateX: 0 → 3px → -3px → 2px → -1px → 0
  - `animation: winShake 0.15s ease-out`

**"Prize will be credited to your account"** — show this below the prize amount in small gray text.

### Loss Result Changes

**Remove all emojis and icons from the loss overlay.** No emoji, no "X" circle, no icon.

**Text layout (centered, stacked):**
- "BETTER LUCK NEXT TIME" — heading, uppercase, font-weight 800, color white (opacity 0.7), letter-spacing 2px
- "TRY AGAIN TOMORROW" — subheading below, uppercase, font-weight 700, slightly smaller, color white (opacity 0.4)
- Button: "GOT IT" instead of "OK"

**Tone:** Dignified, not depressing. Cool gray palette, no sad imagery.

## 7. Prompt Screen Changes

### Current State
- Separate full-screen card with 🎡 emoji, "SPIN & WIN" title, input, Play button
- Wheel is NOT visible — completely hidden behind the prompt

### Changes

**Show wheel behind the prompt:**
- When screen === 'prompt', render the full wheel screen in the background
- Overlay a semi-transparent dark backdrop (`rgba(0,0,0,0.6)`) on top
- Show the prompt card on top of the backdrop
- The wheel should be static (not spinning), slightly dimmed through the overlay
- This creates anticipation and a cohesive feel

**Remove emoji:**
- Remove the 🎡 emoji from the prompt card entirely

**White text:**
- "Enter your BwanaBet ID to play" — color: white (was gray-400)
- Input placeholder "Your BwanaBet ID" — color: white at reduced opacity

**Keep everything else the same:**
- Same card styling, same "SPIN & WIN" gold gradient title
- Same input field, same Play/Checking button
- Same validation error display
- Same close button

## 8. Done Overlay

The "done" overlay (shown when user has already spun today) follows the same style as the loss screen:
- No emojis, no icons
- "BETTER LUCK NEXT TIME" heading
- "TRY AGAIN TOMORROW" subheading
- "GOT IT" button
- Overlay shows on top of the wheel (current behavior, keep as-is)

## 9. New CSS Animations Required

```css
/* STOP button flash during spinning */
@keyframes stopFlash {
  0%, 100% { opacity: 0.6; text-shadow: none; }
  50% { opacity: 1; text-shadow: 0 0 12px rgba(239,68,68,0.6), 0 0 24px rgba(239,68,68,0.3); }
}

/* Win screen shake */
@keyframes winShake {
  0% { transform: translateX(0); }
  16% { transform: translateX(3px); }
  33% { transform: translateX(-3px); }
  50% { transform: translateX(2px); }
  66% { transform: translateX(-1px); }
  83% { transform: translateX(1px); }
  100% { transform: translateX(0); }
}
```

## 10. Files to Modify

| File | Changes |
|------|---------|
| `components/WheelWidget.jsx` | Pointer physics, STOP flash, prompt screen layout, result screens, celebration sequence |
| `app/globals.css` | New keyframe animations (stopFlash, winShake) |

No new files. No backend changes. No dependency additions.
