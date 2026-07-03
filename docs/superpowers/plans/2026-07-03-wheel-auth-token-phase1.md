# BwanaBet Token Integration — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual BwanaBet customer-ID entry with automatic identity derived (decode-only) from the logged-in `token` JWT cookie, and only show the wheel to logged-in users.

**Architecture:** `embed.js` runs on the `bwanabet.co.zm` origin, reads the JS-readable `token` cookie, gates the trigger button on its presence, and hands the raw JWT to the iframe widget via a targeted `postMessage` handshake. The widget forwards the token to `/api/spin`, which decodes it server-side (new `lib/bwanaAuth.mjs`) to obtain the customer `id`. No signature verification yet — that is Phase 2, isolated behind a single seam in `lib/bwanaAuth.mjs`.

**Tech Stack:** Next.js 14 (App Router, Node runtime API routes), React 18, plain-JS loader script, Node's built-in `node --test` for the one pure module (no new dependencies).

**Spec:** `docs/superpowers/specs/2026-07-03-wheel-auth-token-integration-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `lib/bwanaAuth.mjs` | Turn a raw JWT string into a trusted identity (decode-only in Phase 1); the single place Phase 2 signature verification will slot into | **Create** |
| `lib/bwanaAuth.test.mjs` | Unit tests for the decode/verify logic | **Create** |
| `package.json` | Add `test` script | Modify |
| `app/api/spin/route.js` | Accept `token`, derive `id` via `verifyBwanaToken`; preserve test-mode `customerId` path | Modify |
| `app/api/validate/route.js` | Manual ID validation no longer exists | **Delete** |
| `public/embed.js` | Read `token` cookie; gate button on login; targeted `bwanabet-auth` postMessage handshake; allow desktop | Modify |
| `components/WheelWidget.jsx` | Remove ID-input screen; receive token via postMessage; add no-token fallback; send token on spin | Modify |
| `public/test.html` | Add "Simulate login / logout" cookie controls so the new gating + handshake are locally verifiable | Modify |

**Message contract (new):**
- Widget → parent, on mount: `{ type: 'bwanabet-wheel-ready' }` (target `'*'` — widget cannot know parent origin)
- Parent (`embed.js`) → iframe, in reply and on open: `{ type: 'bwanabet-auth', token: <rawJwt> }` (targeted at the widget origin)

Existing messages `bwanabet-wheel-close` and `bwanabet-wheel-spun` are unchanged.

---

## Task 1: `lib/bwanaAuth.mjs` — decode-only token verification

**Files:**
- Create: `lib/bwanaAuth.mjs`
- Test: `lib/bwanaAuth.test.mjs`
- Modify: `package.json` (add `test` script)

Uses `.mjs` so the module is native ESM — importable directly by `node --test` (no `"type":"module"` change to the repo) and resolvable by Next via an explicit `.mjs` import in Task 2.

- [ ] **Step 1: Write the failing test**

Create `lib/bwanaAuth.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBwanaToken, decodeJwtPayload, TokenError } from './bwanaAuth.mjs';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
// Build a JWT-shaped string: header.payload.signature (signature ignored in Phase 1)
const makeToken = (payload) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

test('verifyBwanaToken returns identity for a valid token', () => {
  const token = makeToken({ id: 207978, phone: '+260779613904', currency: 'K', exp: FUTURE });
  const ident = verifyBwanaToken(token);
  assert.equal(ident.id, '207978');            // normalized to string
  assert.equal(ident.phone, '+260779613904');
  assert.equal(ident.currency, 'K');
  assert.equal(ident.exp, FUTURE);
});

test('verifyBwanaToken throws expired for a past exp', () => {
  const token = makeToken({ id: 207978, exp: PAST });
  assert.throws(() => verifyBwanaToken(token), (e) => e instanceof TokenError && e.code === 'expired');
});

test('verifyBwanaToken throws expired when exp is missing', () => {
  const token = makeToken({ id: 207978 });
  assert.throws(() => verifyBwanaToken(token), (e) => e.code === 'expired');
});

test('verifyBwanaToken throws no_id when id is absent', () => {
  const token = makeToken({ phone: '+260', exp: FUTURE });
  assert.throws(() => verifyBwanaToken(token), (e) => e.code === 'no_id');
});

test('verifyBwanaToken throws malformed for non-JWT strings', () => {
  assert.throws(() => verifyBwanaToken('not-a-jwt'), (e) => e.code === 'malformed');
  assert.throws(() => verifyBwanaToken(''), (e) => e.code === 'malformed');
  assert.throws(() => verifyBwanaToken(null), (e) => e.code === 'malformed');
});

test('decodeJwtPayload throws malformed on unparseable payload', () => {
  assert.throws(() => decodeJwtPayload('aaa.!!!notbase64json!!!.sig'), (e) => e.code === 'malformed');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test lib/bwanaAuth.test.mjs`
Expected: FAIL — `Cannot find module '.../lib/bwanaAuth.mjs'` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `lib/bwanaAuth.mjs`:

```js
// Decode-only (Phase 1) verification of the BwanaBet session JWT.
//
// Phase 2 will add HS256 signature verification at the marked seam below,
// gated by BWANA_VERIFY_SIGNATURE / BWANA_JWT_SECRET, without changing this
// module's public shape or any caller. See spec §5.3.

export class TokenError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TokenError';
    this.code = code; // 'malformed' | 'expired' | 'no_id'
  }
}

function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

export function decodeJwtPayload(rawToken) {
  if (typeof rawToken !== 'string' || rawToken === '') throw new TokenError('malformed');
  const parts = rawToken.split('.');
  if (parts.length !== 3 || !parts[1]) throw new TokenError('malformed');
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    throw new TokenError('malformed');
  }
  if (!payload || typeof payload !== 'object') throw new TokenError('malformed');
  return payload;
}

export function verifyBwanaToken(rawToken, { now = Date.now() } = {}) {
  const payload = decodeJwtPayload(rawToken);

  // --- Phase 2 seam ---
  // if (process.env.BWANA_VERIFY_SIGNATURE === '1') {
  //   assertValidHs256Signature(rawToken, process.env.BWANA_JWT_SECRET);
  // }
  // --------------------

  if (payload.id === undefined || payload.id === null || payload.id === '') {
    throw new TokenError('no_id');
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) {
    throw new TokenError('expired');
  }

  return {
    id: String(payload.id),
    phone: payload.phone ?? null,
    currency: payload.currency ?? null,
    exp: payload.exp,
  };
}
```

- [ ] **Step 4: Add the `test` script to `package.json`**

In `package.json`, add to `"scripts"` (after `"lint": "next lint"`):

```json
    "lint": "next lint",
    "test": "node --test lib/"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test lib/bwanaAuth.test.mjs`
Expected: PASS — 6 tests, 0 fail. (Also confirm `npm test` runs them.)

- [ ] **Step 6: Commit**

```bash
git add lib/bwanaAuth.mjs lib/bwanaAuth.test.mjs package.json
git commit -m "feat: add decode-only BwanaBet token verification (Phase 1)"
```

---

## Task 2: `/api/spin` — derive customer id from the token

**Files:**
- Modify: `app/api/spin/route.js`

Real traffic sends `{ token, fingerprint }`; the token is decoded to an `id`. Test-mode traffic (gated by the existing `x-wheel-test-token` header + `body.test`) keeps sending `{ customerId, ... }` so `scripts/full-day-simulation.mjs` and the force-win harness are unaffected.

- [ ] **Step 1: Add the import**

At the top of `app/api/spin/route.js`, after the existing imports, add:

```js
import { verifyBwanaToken, TokenError } from '@/lib/bwanaAuth.mjs';
```

- [ ] **Step 2: Replace the customer-id resolution block**

Find this block (currently around lines 31-44):

```js
  const { customerId, fingerprint } = body;

  if (!customerId || typeof customerId !== 'string' || customerId.trim() === '') {
    return NextResponse.json({ error: 'missing_customer_id' }, { status: 400 });
  }
  const forceWin = isTest && typeof body.forceWin === 'number' ? body.forceWin : null;
  const bucket = isTest
    ? (typeof body.testBucket === 'string' && body.testBucket.length > 0 ? body.testBucket : 'stress')
    : '';
  // In test mode, default to skipping dedupe (load tests use unique IDs). Tests
  // that want to verify dedupe itself send body.skipDedupe:false to force it on.
  const skipDedupe = isTest && body.skipDedupe !== false;

  const cleanId = customerId.trim();
```

Replace it with:

```js
  const { token, customerId, fingerprint } = body;

  // Identity: test traffic keeps using an explicit customerId; real traffic
  // derives the id by decoding the BwanaBet session token (Phase 1: no signature check).
  let cleanId;
  if (isTest) {
    if (!customerId || typeof customerId !== 'string' || customerId.trim() === '') {
      return NextResponse.json({ error: 'missing_customer_id' }, { status: 400 });
    }
    cleanId = customerId.trim();
  } else {
    try {
      cleanId = verifyBwanaToken(token).id;
    } catch (err) {
      const code = err instanceof TokenError && err.code === 'expired' ? 'token_expired' : 'invalid_token';
      return NextResponse.json({ error: code }, { status: 401 });
    }
  }

  const forceWin = isTest && typeof body.forceWin === 'number' ? body.forceWin : null;
  const bucket = isTest
    ? (typeof body.testBucket === 'string' && body.testBucket.length > 0 ? body.testBucket : 'stress')
    : '';
  // In test mode, default to skipping dedupe (load tests use unique IDs). Tests
  // that want to verify dedupe itself send body.skipDedupe:false to force it on.
  const skipDedupe = isTest && body.skipDedupe !== false;
```

(The rest of the route — `getWheelDayDate`, `ensure_daily_state`, `claim_spin` keyed on `cleanId`, Telegram notify — is unchanged.)

- [ ] **Step 3: Verify the route still builds**

Run: `npm run build`
Expected: build succeeds; no import/resolution error for `@/lib/bwanaAuth.mjs`.

- [ ] **Step 4: Manually verify token decoding end-to-end (curl)**

Start the dev server in one terminal: `npm run dev`

Build a fake but decodeable token with Node (guaranteed available; avoids `basenc`) and POST a spin (Git Bash):

```bash
TOKEN=$(node -e 'const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const exp=Math.floor(Date.now()/1000)+3600;process.stdout.write(`${b({alg:"HS256",typ:"JWT"})}.${b({id:207978,phone:"+260",currency:"K",exp})}.sig`)')
curl -s -X POST http://localhost:3000/api/spin \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"fingerprint\":\"test-fp\"}"
```

Expected: JSON with `win`/`segmentIndex` (a real spin result), NOT `invalid_token`.

Then verify rejection of a bad token:

```bash
curl -s -X POST http://localhost:3000/api/spin \
  -H 'Content-Type: application/json' \
  -d '{"token":"garbage","fingerprint":"test-fp"}'
```

Expected: `{"error":"invalid_token"}` with HTTP 401.

- [ ] **Step 5: Commit**

```bash
git add app/api/spin/route.js
git commit -m "feat: derive spin identity from BwanaBet token (test-mode customerId preserved)"
```

---

## Task 3: Remove `/api/validate`

**Files:**
- Delete: `app/api/validate/route.js`

Manual ID validation is gone; the `customers`-table lookup it performed is superseded by token identity (spec §9: the verified token is authoritative). The widget's call to it is removed in Task 5.

- [ ] **Step 1: Delete the route**

```bash
git rm app/api/validate/route.js
```

- [ ] **Step 2: Confirm nothing else references it**

Run: `grep -rn "api/validate" app components public lib scripts`
Expected: the only remaining hit is inside `components/WheelWidget.jsx` (removed in Task 5). If anything else references it, stop and reconcile before continuing.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: remove /api/validate — superseded by token identity"
```

---

## Task 4: `public/embed.js` — gate on login + token handshake

**Files:**
- Modify: `public/embed.js`

- [ ] **Step 1: Add the widget origin + token reader near the top**

In `public/embed.js`, find:

```js
  var WIDGET_URL = 'https://wheel-of-fortune-roan.vercel.app';
  // Allow host page to override widget URL (e.g., for test mode)
  if (window.BWANABET_WIDGET_URL) WIDGET_URL = window.BWANABET_WIDGET_URL;
  var STORAGE_KEY = 'bwanabet_wheel_spun';
```

Immediately after it, add:

```js
  var WIDGET_ORIGIN = (function () {
    try { return new URL(WIDGET_URL).origin; } catch (e) { return '*'; }
  })();

  // Read the BwanaBet session cookie and return the raw JWT only if it is
  // present and not expired. Decode-only (matches server Phase 1). Returns null otherwise.
  function readValidToken() {
    try {
      var m = document.cookie.match(/(?:^|;\s*)token=([^;]+)/);
      if (!m) return null;
      var raw = decodeURIComponent(m[1]);
      var parts = raw.split('.');
      if (parts.length !== 3) return null;
      var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (!payload || typeof payload.exp !== 'number') return null;
      if (payload.exp * 1000 <= Date.now()) return null;
      return raw;
    } catch (e) { return null; }
  }
```

- [ ] **Step 2: Gate rendering on a logged-in session**

Find:

```js
  // Don't show if already spun today
  if (hasSpunToday()) return;
```

Replace with:

```js
  // Don't show if already spun today
  if (hasSpunToday()) return;

  // Only show the wheel to logged-in BwanaBet users.
  var authToken = readValidToken();
  if (!authToken) return;
```

- [ ] **Step 3: Send the token into the iframe (handshake + on open)**

Find:

```js
  // --- Open/close ---
  function openWidget() {
    overlay.classList.add('open');
  }
```

Replace with:

```js
  // --- Auth handoff ---
  function sendAuth() {
    var iframe = overlay.querySelector('iframe');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'bwanabet-auth', token: authToken }, WIDGET_ORIGIN);
    }
  }

  // --- Open/close ---
  function openWidget() {
    overlay.classList.add('open');
    sendAuth(); // covers the case where the widget has already mounted
  }
```

- [ ] **Step 4: Reply to the widget's ready handshake**

Find the existing message listener:

```js
  // --- Listen for messages from widget ---
  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.type) return;

    if (e.data.type === 'bwanabet-wheel-close') {
      closeWidget();
    }
```

Insert a new branch right after the `if (!e.data || !e.data.type) return;` line:

```js
  // --- Listen for messages from widget ---
  window.addEventListener('message', function(e) {
    if (!e.data || !e.data.type) return;

    if (e.data.type === 'bwanabet-wheel-ready') {
      sendAuth();
    }

    if (e.data.type === 'bwanabet-wheel-close') {
      closeWidget();
    }
```

- [ ] **Step 5: Manual verification is combined into Task 6/7** (needs the widget + test harness). Commit now.

```bash
git add public/embed.js
git commit -m "feat: embed.js gates button on login and hands token to widget"
```

---

## Task 5: `components/WheelWidget.jsx` — receive token, drop manual entry

**Files:**
- Modify: `components/WheelWidget.jsx`

- [ ] **Step 1: Replace the auth-related state with a token ref**

Find (around lines 118-123):

```js
  // Screen flow: checking → prompt → spinning → stopping → result → done
  const [screen, setScreen] = useState('checking');
  const [customerId, setCustomerId] = useState(prefillUserId || '');
  const [validationError, setValidationError] = useState('');
  const [validating, setValidating] = useState(false);
  const [spinResult, setSpinResult] = useState(null);
```

Replace with:

```js
  // Screen flow: checking → needLogin | prompt → spinning → stopping → result → done
  const [screen, setScreen] = useState('checking');
  const [spinResult, setSpinResult] = useState(null);
```

Then find the `fingerprintRef` declaration (around line 134):

```js
  const fingerprintRef = useRef(null);
```

Add directly after it:

```js
  const fingerprintRef = useRef(null);
  const authTokenRef = useRef(null); // raw BwanaBet JWT, received from parent via postMessage
```

- [ ] **Step 2: Add a stable test-mode id near the other test-mode reads**

Find (around lines 218-221):

```js
  // Test mode: ?test=1 bypasses localStorage check for repeated testing
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const isTestMode = searchParams?.get('test') === '1';
  const forceWinParam = searchParams?.get('forceWin');
```

Replace with:

```js
  // Test mode: ?test=1 bypasses localStorage check for repeated testing
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const isTestMode = searchParams?.get('test') === '1';
  const forceWinParam = searchParams?.get('forceWin');
  // In test mode the server uses an explicit customerId (no token); default 12345.
  const testCustomerId = (prefillUserId || '12345').toString().trim();
```

- [ ] **Step 3: Replace the mount effect to wait for the token**

Find (around lines 223-232):

```js
  // On mount: check localStorage + generate fingerprint
  useEffect(() => {
    generateFingerprint().then(fp => { fingerprintRef.current = fp; }).catch(() => {});

    if (!isTestMode && hasSpunToday()) {
      setScreen('done');
    } else {
      setScreen('prompt');
    }
  }, []);
```

Replace with:

```js
  // On mount: generate fingerprint, then resolve the entry screen.
  // Test mode goes straight to the prompt. Real mode waits for the parent
  // (embed.js) to postMessage the BwanaBet session token.
  useEffect(() => {
    generateFingerprint().then(fp => { fingerprintRef.current = fp; }).catch(() => {});

    if (isTestMode) {
      setScreen('prompt');
      return;
    }

    const onMessage = (e) => {
      if (e.data?.type === 'bwanabet-auth' && typeof e.data.token === 'string' && e.data.token) {
        authTokenRef.current = e.data.token;
        setScreen(hasSpunToday() ? 'done' : 'prompt');
      }
    };
    window.addEventListener('message', onMessage);

    // Ask the parent for the token (handshake). embed.js replies with 'bwanabet-auth'.
    window.parent.postMessage({ type: 'bwanabet-wheel-ready' }, '*');

    // If no token arrives (e.g. widget opened directly / logged out), show the login notice.
    const fallback = setTimeout(() => {
      if (!authTokenRef.current) setScreen('needLogin');
    }, 2000);

    return () => { window.removeEventListener('message', onMessage); clearTimeout(fallback); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 4: Replace `handleValidateAndPlay` with a plain start**

Find (around lines 408-436) the entire `handleValidateAndPlay` callback:

```js
  // Validate customer ID and start playing
  const handleValidateAndPlay = useCallback(async () => {
    const id = customerId.trim();
    if (!id) {
      setValidationError('Please enter your BwanaBet ID');
      return;
    }
    setValidating(true);
    setValidationError('');
    try {
      const res = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: id, fingerprint: fingerprintRef.current }),
      });
      const data = await res.json();
      if (!data.valid) {
        setValidationError(data.error || 'Invalid ID. Please check and try again.');
        setValidating(false);
        return;
      }
      // Valid — start spinning
      setValidating(false);
      setScreen('spinning');
    } catch (err) {
      setValidationError('Network error. Please try again.');
      setValidating(false);
    }
  }, [customerId]);
```

Replace with:

```js
  // Start playing — identity is already established (token in real mode, test id in test mode)
  const startPlaying = useCallback(() => {
    setScreen('spinning');
  }, []);
```

- [ ] **Step 5: Update the spin request body in `stopWheel`**

Find (around lines 448-452):

```js
    fetch('/api/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: customerId.trim(), fingerprint: fingerprintRef.current, test: isTestMode, ...(forceWinParam ? { forceWin: Number(forceWinParam) || true } : {}) }),
    })
```

Replace with:

```js
    fetch('/api/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        isTestMode
          ? { customerId: testCustomerId, fingerprint: fingerprintRef.current, test: true, ...(forceWinParam ? { forceWin: Number(forceWinParam) || true } : {}) }
          : { token: authTokenRef.current, fingerprint: fingerprintRef.current }
      ),
    })
```

- [ ] **Step 6: Fix the `stopWheel` dependency array**

The `stopWheel` callback currently ends with `}, [customerId]);` (around line 483). `customerId` no longer exists. Change that line to:

```js
  }, [isTestMode, forceWinParam, testCustomerId]);
```

- [ ] **Step 7: Replace the prompt overlay (remove the input)**

Find the prompt overlay block. Replace everything from the description paragraph through the Play button — specifically from this line (around line 607):

```js
            <p className="text-white text-sm mt-2 mb-5">Enter your BwanaBet ID to play</p>

            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={customerId}
              onChange={e => { setCustomerId(e.target.value); setValidationError(''); }}
              onKeyDown={e => { if (e.key === 'Enter' && !validating) handleValidateAndPlay(); }}
              placeholder="Your BwanaBet ID"
              className="w-full px-4 py-3 rounded-xl text-center text-lg font-bold text-white outline-none transition-all focus:ring-2 focus:ring-amber-400/50"
              style={{
                background: 'rgba(0,0,0,0.4)',
                border: validationError ? '2px solid #ef4444' : '2px solid rgba(255,255,255,0.1)',
                '::placeholder': { color: 'rgba(255,255,255,0.4)' },
              }}
              disabled={validating}
            />

            {validationError && (
              <p className="text-red-400 text-xs mt-2 font-medium">{validationError}</p>
            )}

            <button
              type="button"
              onClick={handleValidateAndPlay}
              disabled={validating}
              className="w-full mt-4 py-3.5 rounded-xl font-bold text-lg shadow-lg transition-all hover:scale-[1.03] active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                boxShadow: '0 4px 15px rgba(245,158,11,0.3)',
              }}
            >
              {validating ? 'Checking...' : 'Play!'}
            </button>
```

Replace that whole span with:

```js
            <p className="text-white text-sm mt-2 mb-5">Tap below and spin to win!</p>

            <button
              type="button"
              onClick={startPlaying}
              className="w-full mt-2 py-3.5 rounded-xl font-bold text-lg shadow-lg transition-all hover:scale-[1.03] active:scale-95"
              style={{
                background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                boxShadow: '0 4px 15px rgba(245,158,11,0.3)',
              }}
            >
              Play!
            </button>
```

- [ ] **Step 8: Add the `needLogin` overlay**

Directly before the prompt overlay block (find the comment `{/* PROMPT OVERLAY — wheel visible behind */}` around line 573), insert a new screen block just above it:

```js
      {/* ============================================================ */}
      {/* NEED-LOGIN OVERLAY — shown when no BwanaBet session token     */}
      {/* ============================================================ */}
      {screen === 'needLogin' && (
        <div className="fixed inset-0 z-[58] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', animation: 'fadeIn 0.3s ease-out' }}>
          <div className="relative text-center p-8 rounded-2xl max-w-xs w-full mx-4" style={{
            background: 'linear-gradient(180deg, #2d3348 0%, #1e2233 40%, #1a1e2e 100%)',
            border: '3px solid #3a3f52',
            boxShadow: '0 0 80px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.06)',
          }}>
            <button type="button" onClick={handleClose}
              className="absolute top-3 right-3 z-40 w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-90"
              style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 2px 8px rgba(239,68,68,0.5)' }}>
              <X className="w-5 h-5 text-white" strokeWidth={3} />
            </button>
            <div className="text-lg font-extrabold uppercase tracking-widest mb-2 mt-4" style={{ color: 'rgba(255,255,255,0.85)', letterSpacing: '2px' }}>
              PLEASE LOG IN
            </div>
            <p className="text-gray-400 text-sm mb-2">Log in to your BwanaBet account to spin the wheel.</p>
          </div>
        </div>
      )}
```

- [ ] **Step 9: Verify it builds and lints**

Run: `npm run build`
Expected: build succeeds. No references remain to `customerId`, `validationError`, `validating`, or `handleValidateAndPlay` (a `next build` will error on undefined identifiers if any were missed).

- [ ] **Step 10: Commit**

```bash
git add components/WheelWidget.jsx
git commit -m "feat: widget auto-receives token via postMessage, drops manual ID entry"
```

---

## Task 6: `public/test.html` — simulate login for local verification

**Files:**
- Modify: `public/test.html`

The real `token` cookie only exists on `bwanabet.co.zm`. Locally we set a decodeable fake one so `embed.js` gating and the handshake can be exercised on `localhost`.

- [ ] **Step 1: Add "Simulate login / logout" buttons**

Find the second `.controls` row (the force-win buttons, around lines 64-69) and add a new controls row right after its closing `</div>`:

```html
      <div class="controls">
        <button class="btn btn-blue" onclick="simulateLogin()" style="background:#0ea5e9;">Simulate Login</button>
        <button class="btn btn-gray" onclick="simulateLogout()">Log Out</button>
      </div>
```

- [ ] **Step 2: Add the cookie helpers to the page script**

In the `<script>` block, just before `function getWidgetUrl() {` (around line 200), add:

```js
    function makeFakeToken() {
      var b64url = function (obj) {
        return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      };
      var exp = Math.floor(Date.now() / 1000) + 3600;
      var header = b64url({ alg: 'HS256', typ: 'JWT' });
      var payload = b64url({ id: 207978, phone: '+260779613904', currency: 'K', exp: exp });
      return header + '.' + payload + '.sig';
    }

    function simulateLogin() {
      document.cookie = 'token=' + makeFakeToken() + '; path=/; max-age=3600';
      log('Simulated login — token cookie set (id 207978). Reloading widget...', 'info');
      reloadEmbed();
    }

    function simulateLogout() {
      document.cookie = 'token=; path=/; max-age=0';
      log('Logged out — token cookie cleared. Reloading widget...', 'info');
      reloadEmbed();
    }
```

- [ ] **Step 3: Load the widget without `?test=1` so the real token path runs**

Find (around line 200-204):

```js
    function getWidgetUrl() {
      var url = window.location.origin + '?test=1';
      if (currentForceWin) url += '&forceWin=' + currentForceWin;
      return url;
    }
```

Replace with:

```js
    function getWidgetUrl() {
      // With a simulated token cookie present we exercise the REAL token path (no ?test=1).
      // Force-win still requires test mode, so only switch to test mode when forcing a win.
      if (currentForceWin) return window.location.origin + '?test=1&forceWin=' + currentForceWin;
      return window.location.origin;
    }
```

- [ ] **Step 4: Commit**

```bash
git add public/test.html
git commit -m "test: add simulate-login cookie controls to widget test harness"
```

---

## Task 7: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run: `npm run dev` (leave running).

- [ ] **Step 2: Verify logged-out state hides the button**

Open `http://localhost:3000/test.html`. Click **Log Out**, then **Check Status**.
Expected: the floating gift-box trigger button does NOT appear (no token cookie → `embed.js` returns early). The "Trigger button" status may still read from localStorage — the visual truth is: no button on the right edge.

- [ ] **Step 3: Verify logged-in state shows the button and auto-detects identity**

Click **Clear Spin (Reset)**, then **Simulate Login**.
Expected: the trigger button appears. Click it → the wheel opens directly to the **SPIN AND WIN / Play!** screen (no ID input field anywhere).

- [ ] **Step 4: Verify a full spin works without typing an ID**

Click **Play!**, let the wheel spin, click **STOP**.
Expected: the wheel lands and shows a win or "Try Again Tomorrow" result. The Event Log shows `Spin complete!`. In DevTools Network, the `POST /api/spin` request body contains `"token":"eyJ..."` and NO `customerId`.

- [ ] **Step 5: Verify the no-token fallback**

In a new tab open `http://localhost:3000/` directly (no embed, no cookie handshake).
Expected: after ~2s the widget shows the **PLEASE LOG IN** notice (not a spinnable wheel).

- [ ] **Step 6: Verify force-win harness still works (test-mode path intact)**

Back on `test.html`, click **Force Win K200**, then open the widget and spin/stop.
Expected: lands on K200; `POST /api/spin` body contains `"customerId":"12345"` and `"test":true`. This confirms the test-mode path is preserved.

- [ ] **Step 7: Run the unit tests and build once more**

Run: `npm test`
Expected: 6 tests pass.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 8: Final commit (if any verification tweaks were needed)**

```bash
git add -A
git commit -m "chore: Phase 1 token integration verified end-to-end"
```

---

## Rollout note (post-merge, not a code task)

`embed.js` on `bwanabet.co.zm` is the same `<script src=embed.js>` tag they already include — no change needed on their side to ship Phase 1. The only dependency is that the `token` cookie stays JS-readable (not `HttpOnly`), which is already the case. Phase 2 (signature verification) is a later change confined to the seam in `lib/bwanaAuth.mjs` plus the `BWANA_JWT_SECRET` / `BWANA_VERIFY_SIGNATURE` env vars.
