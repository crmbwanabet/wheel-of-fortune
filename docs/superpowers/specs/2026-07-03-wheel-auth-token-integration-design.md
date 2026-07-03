# Wheel of Fortune — Auth Token Integration Design

**Date:** 2026-07-03
**Repo:** `crmbwanabet/wheel-of-fortune`
**Database:** Supabase (`blrrcnrhixckfudiojwe`)
**Deployed at:** `https://wheel-of-fortune-roan.vercel.app`

---

## 1. Overview

Today the widget asks each user to **type their BwanaBet customer ID**, then validates that string against a `customers` snapshot table. This is friction, and it is spoofable — anyone can type any ID.

This spec replaces manual entry with **automatic, verified identity** derived from the logged-in BwanaBet session. The `bwanabet.co.zm` page already sets a JavaScript-readable `token` cookie (a JWT) once a user logs in. Our loader script reads it, hands it to the widget, and our backend verifies it and derives the customer ID server-side. The user never types anything, and the widget only appears for logged-in users.

This also removes the mobile-only restriction: the wheel now shows for any logged-in user on any device.

## 2. What the investigation established (2026-07-03, Chrome DevTools on a live logged-in session)

- On login, `bwanabet.co.zm` sets a cookie named **`token`** — a JWT, **not `HttpOnly`**, readable via `document.cookie`.
- Decoded payload contains, among other fields:
  - `id` (numeric customer ID — the value shown as "ID: NNNNNN" in the site header)
  - `phone`, `username`, `currency`, `country`, `balance`
  - `iat` / `exp` — issued-at and expiry (~24h lifetime)
- Header: `{ "alg": "HS256", "typ": "JWT" }` — symmetric signature; verifiable only with BwanaBet's signing secret.
- `embed.js` runs on the **`bwanabet.co.zm` origin**, so it can read this cookie. The iframe widget runs on the **Vercel origin** and (by browser cross-origin isolation) cannot read the cookie itself — the parent script must pass it in.

## 3. External dependency — the ask to the BwanaBet developer

We need **one** of the following from BwanaBet (in order of our preference; any of the three satisfies the design):

1. **The HS256 signing secret** for the `token` JWT — simplest for us, most sensitive for them.
2. **A dedicated secret** signing a separate minimal token (`id` + `exp`) — safer for them; our side never holds their master key.
3. **A server-to-server verify endpoint** (`POST` token → canonical `id`) — no secret leaves BwanaBet at all.

We must **also** obtain, regardless of which option:

- A commitment that the `token` cookie **stays readable by JavaScript** (not `HttpOnly`), or an alternative mechanism to obtain the token if they change that. The entire detection path depends on this.
- Whether/when the secret **rotates**, so we can plan key management.

The backend's `verifyBwanaToken()` module (§5.3) is written so that whichever option BwanaBet chooses is a localized change; the rest of the system is identical.

## 4. Rollout phases

The user-facing flow is identical in both phases; only the backend verification body differs.

- **Phase 1 — decode-only (ship without waiting on BwanaBet):** backend base64-decodes the JWT payload, reads `id`, enforces `exp`. Not forgery-proof, but eliminates manual typing and casual fake IDs, and forging *someone else's* ID has no payoff (prizes pay out to a real account).
- **Phase 2 — verified (once the secret/endpoint arrives):** backend cryptographically verifies the token before trusting `id`. Flipping phases is a change inside `verifyBwanaToken()` only.

## 5. Architecture

### 5.1 Data flow

```
bwanabet.co.zm page
 └─ embed.js  (bwanabet origin — CAN read the token cookie)
     1. read `token` cookie
     2. missing / expired         → do NOT render the wheel trigger button
     3. present                   → render button
     4. on open: postMessage the RAW JWT to the iframe, targeted at the Vercel origin
          │  { type: 'bwanabet-auth', token: <jwt> }
          ▼
   iframe widget (Vercel)
     5. receive JWT via message listener, hold in memory (never in the URL)
     6. on spin: POST { token, fingerprint } to /api/spin
          │
          ▼
   backend (/api/spin)
     7. verifyBwanaToken(token)  →  { id, phone, currency, exp }   (Phase 1 decode / Phase 2 verify)
     8. reject if token missing / malformed / expired
     9. run existing rigged-spin logic keyed on the derived `id`
```

### 5.2 Why these choices

- **postMessage, not a URL param.** A JWT in `?token=…` leaks into history, `Referer` headers, and access logs. postMessage keeps it out of the URL and is pinned to the exact Vercel origin so no sibling frame can read it.
- **The widget never trusts its own decode.** It only ferries the token. All identity decisions are server-side, so Phase 1 → Phase 2 is a backend-only change.
- **Backend re-derives identity from the token every spin; the client-supplied `customerId` string is removed entirely.** This is the core anti-abuse win — there is no field to type a foreign ID into, and the backend ignores anything but the token.
- **`exp` enforced.** A stale (>24h) token is rejected, so a spin reflects a genuinely active session.

### 5.3 `verifyBwanaToken()` — new module (`lib/bwanaAuth.js`)

Single responsibility: turn a raw JWT string into a trusted identity, or throw.

```
verifyBwanaToken(rawToken) -> { id: string, phone, currency, exp }
  - split & base64url-decode header + payload
  - Phase 1: skip signature check
  - Phase 2: verify HS256 signature with BWANA_JWT_SECRET
             (or call BwanaBet verify endpoint, per chosen option)
  - assert payload.exp > now
  - assert payload.id present
  - return normalized identity ({ id: String(payload.id), ... })
  - throw a typed error on any failure (malformed / expired / bad_signature)
```

- Secret read from `process.env.BWANA_JWT_SECRET` (unset in Phase 1).
- A single boolean/env (`BWANA_VERIFY_SIGNATURE`) selects Phase 1 vs Phase 2 without a code deploy.

## 6. Endpoint changes

### 6.1 `/api/validate` — removed

Manual ID validation no longer exists. The `customers`-table lookup it performed is superseded by token verification. (If a defensive cross-check against `customers` is still wanted, it moves into `/api/spin` after token derivation — see §9 open question.)

### 6.2 `/api/spin` — modified

- Request body becomes `{ token, fingerprint }` (was `{ customerId, fingerprint }`).
- Before rate-limit/claim logic: `const { id } = verifyBwanaToken(token)`.
  - On throw → `401 { error: 'invalid_token' }` (or `token_expired`).
- Everything downstream (`ensure_daily_state`, `claim_spin`, Telegram notify) is keyed on the derived `id` exactly as it was keyed on `customerId` — no DB/RPC changes.
- **Test-mode path is preserved.** The existing `x-wheel-test-token` header + `body.test` gate stays; in test mode the derived-id requirement is satisfied by an explicit `body.customerId` so load tests keep using synthetic IDs without minting JWTs.

## 7. Widget changes (`components/WheelWidget.jsx`)

- **Remove** the ID-input screen (input, "Enter your BwanaBet ID", validation error, the `/api/validate` call).
- **Add** a `message` listener that accepts `{ type: 'bwanabet-auth', token }` — with an origin check against the known bwanabet origin — and stores the token in memory.
- Send `{ token, fingerprint }` to `/api/spin` on spin.
- **No-token fallback:** if the widget is opened without ever receiving a token (logged out, or the Vercel URL opened directly), show "Please log in to BwanaBet to play" instead of the spinner. No silent failure.
- Existing outbound messages (`bwanabet-wheel-close`, `bwanabet-wheel-spun`) are unchanged.

## 8. Loader changes (`public/embed.js`)

- Add a `token`-cookie read (same CAT day/`localStorage` guards as today remain).
- **Gate rendering on login:** if no readable `token` cookie, do not inject the trigger button at all.
- On open, `postMessage({ type: 'bwanabet-auth', token }, WIDGET_ORIGIN)` into the iframe (targeted, not `'*'`).
- Drop the mobile-only assumption; the button may render on desktop too.

## 9. Open questions / decisions

- **Cross-check against `customers` table?** A verified token already proves a real BwanaBet user. The local `customers` snapshot may be stale and could false-reject a genuine new user. **Proposed default:** trust the verified token as authoritative and drop the `customers` lookup; keep it only as a non-blocking log if desired.
- **Token refresh mid-session:** out of scope — the 24h `exp` comfortably covers a single daily spin.

## 10. Out of scope

- Any change to the rigged win-selection logic, daily budget, dedupe, or rate limiting.
- Changes to BwanaBet's own site beyond the `<script src=embed.js>` tag they already include and the cookie/secret commitments in §3.

## 11. Affected files

| File | Change |
|------|--------|
| `public/embed.js` | Read `token` cookie; gate button on login; targeted `bwanabet-auth` postMessage; allow desktop |
| `components/WheelWidget.jsx` | Remove ID-input + `/api/validate`; add token listener + no-token fallback; send token on spin |
| `lib/bwanaAuth.js` | **New** — `verifyBwanaToken()` with Phase 1/Phase 2 seam |
| `app/api/spin/route.js` | Accept `token`, verify, derive `id`; preserve test-mode |
| `app/api/validate/route.js` | Remove |
| env | `BWANA_JWT_SECRET`, `BWANA_VERIFY_SIGNATURE` (Phase 2) |
