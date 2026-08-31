'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { X, Sparkles } from 'lucide-react';
import { generateFingerprint } from '@/lib/fingerprint';
import { hasSpun, withSpun } from '@/lib/spunCache.mjs';
import { decideAvailability } from '@/lib/availability.mjs';
import { classifySpinRecovery } from '@/lib/spinRecovery';
import { computeLanding } from '@/lib/wheelLanding';
import { resolveLandingSegment } from '@/lib/landingSegment';
import { msUntilNextWheelReset, splitCountdown } from '@/lib/countdown';
import { nextWinner, nextDelayMs } from '@/lib/winnerTicker';
import { resolveGame, BOX_LABELS, boxDecoys } from '@/lib/gameRotation';

// ============================================================================
// DATA — 14 segments: six real prizes on even indices 0..10 in ascending
// order, the DISPLAY-ONLY K10,000 jackpot at index 12, losses on odds.
// Index 12 is unreachable: the server maps prizes only to 0,2,4,6,8,10 and
// losses only to odd indices. See lib/jackpotSafety.test.mjs.
// ============================================================================
const WHEEL_SEGMENTS = [
  { id: 1,  label: 'K5',                 prize: { kwacha: 5 },     color: '#00e5ff', isLoss: false },
  { id: 2,  label: 'Try Again Tomorrow', prize: null,              color: '#78909c', isLoss: true },
  { id: 3,  label: 'K10',                prize: { kwacha: 10 },    color: '#00e676', isLoss: false },
  { id: 4,  label: 'Try Again Tomorrow', prize: null,              color: '#78909c', isLoss: true },
  { id: 5,  label: 'K20',                prize: { kwacha: 20 },    color: '#d500f9', isLoss: false },
  { id: 6,  label: 'Try Again Tomorrow', prize: null,              color: '#78909c', isLoss: true },
  { id: 7,  label: 'K50',                prize: { kwacha: 50 },    color: '#ff6d00', isLoss: false },
  { id: 8,  label: 'Try Again Tomorrow', prize: null,              color: '#78909c', isLoss: true },
  { id: 9,  label: 'K100',               prize: { kwacha: 100 },   color: '#ffd600', isLoss: false },
  { id: 10, label: 'Try Again Tomorrow', prize: null,              color: '#78909c', isLoss: true },
  { id: 11, label: 'K200',               prize: { kwacha: 200 },   color: '#ffab00', isLoss: false },
  { id: 12, label: 'Try Again Tomorrow', prize: null,              color: '#78909c', isLoss: true },
  // The jackpot is DISPLAY-ONLY: prize:null and isLoss:true mean that even if
  // some future code path ever set this segment as the result, the widget
  // would render a loss with no amount — the string "K10,000" exists only as
  // slice artwork, never as a winnable prize object.
  { id: 13, label: 'K10,000',            prize: null,              color: '#c50e1f', isLoss: true,  isJackpot: true },
  { id: 14, label: 'Try Again Tomorrow', prize: null,              color: '#78909c', isLoss: true },
];

const NUM = WHEEL_SEGMENTS.length;
const SEG_ANGLE = 360 / NUM;

// The BwanaBet brand yellow, sampled directly from the logo PNG served by the
// live site (bwanabet-logo-long.png): the dominant colour across 72,294 of its
// pixels. Every BWANABET wordmark in the widget uses this and nothing else, so
// the wheel reads as part of the same brand rather than an approximation.
//
// The site's REGISTER button is #FFF100 — one unit off in red and green, and
// visually identical. If you ever need to match chrome rather than the
// wordmark, that is the other value.
const BWANA_YELLOW = '#FEF200';

// window.onerror messages that are not worth an alert. Each report costs a
// Telegram message to the owner and a write to the database shared with the
// CRM, so anything that fires routinely and means nothing has to be excluded
// or the channel stops being read.
const IGNORED_WINDOW_ERRORS = [
  'ResizeObserver loop',        // browser deferring a notification; harmless
  'Script error.',              // cross-origin script with no detail attached
];

// ============================================================================
// AUTH ORIGIN ALLOWLIST
// The widget receives the BwanaBet session token from its parent page via
// postMessage. Only accept that token from a known BwanaBet origin (or from
// our own origin, which covers the local test harness and direct opens).
// Add any further BwanaBet host domains here as they are confirmed.
// ============================================================================
const ALLOWED_AUTH_ORIGINS = new Set([
  'https://bwanabet.com',
  'https://bwanabet.co.zm',
  // `www.` variants: www.bwanabet.com currently 301s to the apex and
  // www.bwanabet.co.zm 404s, but if either ever serves the site directly the
  // token would be silently dropped and the wheel would never appear.
  'https://www.bwanabet.com',
  'https://www.bwanabet.co.zm',
  // TEMPORARY (2026-07-21): BwanaBet dev environment for pre-launch widget
  // testing. Remove once the team confirms testing is done.
  'https://dev-bwanabet.energaming.services',
  // TEMPORARY (2026-08-24): BwanaBet staging environment, requested by their
  // dev team for wheel + subscribe-icon placement testing. Remove with the
  // dev entry above once testing wraps.
  'https://staging-bwanabet.energaming.services',
]);

function isAllowedAuthOrigin(origin) {
  if (typeof window !== 'undefined' && origin === window.location.origin) return true;
  return ALLOWED_AUTH_ORIGINS.has(origin);
}

// ============================================================================
// LOCALSTORAGE — 6am CAT reset
// ============================================================================
const STORAGE_KEY = 'bwanabet_wheel_spin';

// Availability check timeout. Without this a HANG (as opposed to an error)
// means the widget never posts a verdict and the trigger button never appears
// until a full page reload — the `checked` latch prevents any retry.
// Note the budget starts before `await fpPromise`, so it nominally covers
// fingerprint generation too — in practice that promise starts at mount and has
// long settled by the time an auth token arrives.
const STATUS_TIMEOUT_MS = 4000;

function getWheelDayClient() {
  const now = new Date();
  const catMs = now.getTime() + (2 * 60 * 60 * 1000);
  const catDate = new Date(catMs);
  if (catDate.getUTCHours() < 9) {
    catDate.setUTCDate(catDate.getUTCDate() - 1);
  }
  return catDate.toISOString().split('T')[0];
}

// Browser-safe decode of the BwanaBet JWT payload id (no signature check —
// this only keys a client-side cache; the server re-verifies on every call).
function customerIdFromToken(raw) {
  try {
    const part = String(raw).split('.')[1];
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return payload && payload.id != null && payload.id !== '' ? String(payload.id) : null;
  } catch {
    return null;
  }
}

function hasSpunToday(customerId) {
  try {
    return hasSpun(localStorage.getItem(STORAGE_KEY), customerId, getWheelDayClient());
  } catch {
    return false;
  }
}

function markSpun(customerId) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      withSpun(localStorage.getItem(STORAGE_KEY), customerId, getWheelDayClient()),
    );
  } catch { /* ignore quota/availability errors */ }
}

// One retry on network error / 503 server_busy — a timed-out spin is safe to
// retry because the server dedupes (returns already_spun if the first committed).
async function postSpinWithRetry(body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('/api/spin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 503 && attempt === 0) {
        await new Promise(r => setTimeout(r, 600));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 600));
        continue;
      }
      throw err;
    }
  }
}

// Ask the server what actually happened to a spin whose response never arrived.
// Resolves to the parsed body, or null if even this call fails — the caller
// (lib/spinRecovery.js) treats null as "we learned nothing", never as a result.
async function fetchSpinStatus(token, fingerprint) {
  try {
    const res = await fetch('/api/spin-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, fingerprint }),
    });
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

// Tell the server the result card actually rendered. Fire-and-forget, once
// per page load; keepalive so a tab closing on the card still delivers it.
// Real traffic only — test spins have no BwanaBet token.
let _ackSent = false;
function ackResultShown(token, result) {
  if (_ackSent || !token || !result) return;
  _ackSent = true;
  try {
    fetch('/api/spin-ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ token, won: !result.isLoss, prize: result.prize?.kwacha ?? null }),
    }).catch(() => {});
  } catch { /* never break the result screen */ }
}

// Best-effort client error reporter → /api/telemetry. Deduped to one report
// per signature per page load; fully fire-and-forget (never throws/awaits).
const _reportedSigs = new Set();
function reportClientError(type, message, context, customerId) {
  try {
    const sig = `${type}:${String(message).slice(0, 80)}`;
    if (_reportedSigs.has(sig)) return;
    _reportedSigs.add(sig);
    fetch('/api/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // customerId matters most on spin_network_error: the server may have
      // recorded the spin while the response never reached the phone, so the
      // customer used their spin and saw a failure. Without the account there
      // is no way to find those people afterwards.
      body: JSON.stringify({
        type,
        message: String(message).slice(0, 500),
        context,
        customerId: customerId != null ? String(customerId) : null,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* never break the widget */ }
}

// Scales its text to fill the width of its parent button.
//
// Hand-tuning a font size per label looks fine until the wording changes — and
// these labels have changed repeatedly. This measures instead: render at `max`,
// read the natural width, then scale to `fill` of the space available. Re-runs
// when the text changes and when the button resizes, so it survives both new
// copy and a rotated phone.
//
// `min` is a floor, not a target: a long label shrinks to fit rather than
// overflowing, which is the failure mode that matters on a 320px screen.
function FitText({ children, max = 32, min = 13, fill = 0.9, className = '', style = {} }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    const parent = el && el.parentElement;
    if (!el || !parent) return;
    let raf = 0;
    let applied = null;
    const fit = () => {
      el.style.fontSize = `${max}px`;
      const natural = el.scrollWidth;
      const avail = parent.clientWidth * fill;
      if (!natural || !avail) { if (applied != null) el.style.fontSize = `${applied}px`; return; }
      const next = Math.max(min, Math.min(max, max * (avail / natural)));
      const rounded = Number(next.toFixed(1));
      applied = rounded;
      el.style.fontSize = `${rounded}px`;
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    // Deferred to the next frame, and skipped when the size would not change.
    //
    // Measuring resets font-size to `max`, which resizes this element, which
    // the observer sees — a loop. Browsers break it by dropping notifications
    // and firing "ResizeObserver loop completed with undelivered
    // notifications", which this widget's window.onerror handler then reports
    // to Telegram and the shared database. Four of those landed in production
    // telemetry within two hours of the first deploy.
    const onResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const before = applied;
        fit();
        if (applied === before) return;   // nothing moved; don't churn
      });
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(parent);
    return () => { if (raf) cancelAnimationFrame(raf); ro.disconnect(); };
  }, [children, max, min, fill]);
  return (
    <span ref={ref} className={className}
      style={{ display: 'block', whiteSpace: 'nowrap', lineHeight: 1.05, ...style }}>
      {children}
    </span>
  );
}

// Readerboard above the wheel: a rotating line of simulated winners between
// two bulb rails — the same rails the loss card's countdown strip uses, so it
// reads as part of the cabinet. Data rules live in lib/winnerTicker.js.
// Low-end devices skip the rail pulse and the swap animation, matching how
// the rest of the widget degrades.
function WinnerTicker({ isLowEnd }) {
  // currentRef mirrors what is ON SCREEN so the loop can pick each delay from
  // it synchronously. Deciding the delay inside the setWinner updater is a
  // trap: React runs updaters at render time, AFTER the next timeout is
  // scheduled, so the delay would trail the display by one line — a jackpot
  // would hold 2s and the ordinary line after it 3s.
  const currentRef = useRef(null);
  const [winner, setWinner] = useState(() => {
    const w = nextWinner(null);
    currentRef.current = w;
    return w;
  });
  const [swap, setSwap] = useState(0);
  useEffect(() => {
    let timer;
    let cancelled = false;
    const loop = () => {
      // A jackpot line holds 1s longer than an ordinary win so the rare
      // flash gets read.
      timer = setTimeout(() => {
        if (cancelled) return;
        const w = nextWinner(currentRef.current ? currentRef.current.name : null);
        currentRef.current = w;
        setWinner(w);
        setSwap((n) => n + 1);
        loop();
      }, nextDelayMs(currentRef.current));
    };
    loop();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const rail = {
    position: 'absolute', left: 7, right: 7, height: 3,
    background: 'repeating-linear-gradient(90deg,#ffd24a 0 3px,transparent 3px 11px)',
    filter: 'drop-shadow(0 0 3px rgba(255,210,74,0.6))',
    ...(isLowEnd ? {} : { animation: 'bwTickerRail 2.6s ease-in-out infinite' }),
  };
  return (
    <div aria-hidden="true" style={{
      // marginTop clears the close button, which floats at top:12px and is
      // 36px tall — the board's top edge starts at its bottom edge.
      position: 'relative', margin: '32px 0 10px', padding: '11px 10px 10px',
      background: '#0d0f17', border: '1px solid #333a4d', borderRadius: 8,
      boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.55)', overflow: 'hidden',
    }}>
      <div style={{ ...rail, top: 4 }} />
      <div style={{ ...rail, bottom: 4 }} />
      {/* key remounts the line so the board visibly refreshes on each winner */}
      <div key={swap} style={isLowEnd ? {} : { animation: 'bwTickerIn 0.35s ease-out' }}>
        <FitText max={13} min={8} fill={0.97} className="font-bold uppercase" style={{
          textAlign: 'center',
          letterSpacing: '0.08em',
          fontVariantNumeric: 'tabular-nums',
          color: winner.jackpot ? '#ff5f5f' : '#fff',
          textShadow: winner.jackpot
            ? '0 0 10px rgba(255,95,95,0.55)'
            : '0 0 8px rgba(255,255,255,0.35)',
        }}>
          {winner.name.toUpperCase()}.{winner.surname.charAt(0).toUpperCase()} FROM {winner.town.toUpperCase()} WON{winner.jackpot ? ' THE JACKPOT OF' : ''}{' '}
          <span style={{ color: '#ffd24a' }}>
            K{winner.prize.toLocaleString('en-US')}
          </span>!
        </FitText>
      </div>
    </div>
  );
}

// Test-mode-only simulated outcome. Browser test spins cannot authenticate
// (the test token is a server secret), so /api/spin always rejects them and
// every reviewer used to see a scripted loss — wins were unreviewable. In
// test mode the outcome is synthesised locally instead: ?forceWin=<amount>
// picks that exact prize, otherwise 50/50 win/loss across the real prizes.
// Real traffic never reaches this path.
function simulateTestOutcome(forceWinParam) {
  const winSegs = WHEEL_SEGMENTS
    .map((s, i) => ({ s, i }))
    .filter((x) => !x.s.isLoss && x.s.prize);
  // forceWin=0 forces a LOSS — the deterministic way to review the loss screen.
  if (forceWinParam === '0') {
    return { winIndex: resolveLandingSegment(-1).index, data: { won: false } };
  }
  if (forceWinParam) {
    const want = Number(forceWinParam);
    const hit = winSegs.find((x) => x.s.prize.kwacha === want) || winSegs[0];
    return { winIndex: hit.i, data: { won: true, prize: { kwacha: hit.s.prize.kwacha } } };
  }
  if (Math.random() < 0.5) {
    const hit = winSegs[Math.floor(Math.random() * winSegs.length)];
    return { winIndex: hit.i, data: { won: true, prize: { kwacha: hit.s.prize.kwacha } } };
  }
  return { winIndex: resolveLandingSegment(-1).index, data: { won: false } };
}

// Casino backdrop for box days: a whisper-quiet repeating tile of card suits
// and dots, inlined as ~1KB of SVG so it ships inside the bundle — no image
// request, no late pop-in, crisp at any pixel density. Opacities are kept
// around 5% so the motif reads as texture, never as content.
const SUIT_TILE = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Cpath d='M30 16l8 12-8 12-8-12z' fill='rgba(255,215,0,0.11)'/%3E%3Cpath d='M94 30c-6-8-15-4-15 2.5 0 6.5 15 15.5 15 15.5s15-9 15-15.5c0-6.5-9-10.5-15-2.5z' fill='rgba(239,68,68,0.10)'/%3E%3Cpath d='M34 84c5.5 7 11 10 11 15.5a5.5 5.5 0 0 1-9.6 3.6 13 13 0 0 0 2.1 6.4h-7a13 13 0 0 0 2.1-6.4 5.5 5.5 0 0 1-9.6-3.6c0-5.5 5.5-8.5 11-15.5z' fill='rgba(255,255,255,0.09)'/%3E%3Cg fill='rgba(255,255,255,0.08)'%3E%3Ccircle cx='98' cy='92' r='6'/%3E%3Ccircle cx='91' cy='101' r='6'/%3E%3Ccircle cx='105' cy='101' r='6'/%3E%3Crect x='96.5' y='102' width='3' height='10' rx='1'/%3E%3C/g%3E%3Ccircle cx='94' cy='64' r='1.8' fill='rgba(255,215,0,0.09)'/%3E%3Ccircle cx='30' cy='56' r='1.8' fill='rgba(255,255,255,0.08)'/%3E%3C/svg%3E\")";
const WM_DIAMOND = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cpath d='M60 6l36 54-36 54-36-54z' fill='rgba(255,215,0,0.07)'/%3E%3C/svg%3E\")";
const WM_SPADE = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cpath d='M70 10c22 27 44 41 44 63a22 22 0 0 1-38 14 52 52 0 0 0 8 27h-28a52 52 0 0 0 8-27 22 22 0 0 1-38-14c0-22 22-36 44-63z' fill='rgba(255,255,255,0.055)'/%3E%3C/svg%3E\")";
const CABINET_GRADIENT = 'linear-gradient(180deg, #2d3348 0%, #1e2233 40%, #1a1e2e 100%)';
// Box days sit on black (owner spec) — a whisper of gradient keeps depth so
// it reads as velvet rather than a dead flat fill.
const BOX_BASE_GRADIENT = 'linear-gradient(180deg, #17171c 0%, #0c0c10 45%, #050506 100%)';
// Layer order = paint order (first is on top): gold stage light, vignette,
// two corner beams, the big watermark suits, the repeating suit tile, base.
const BOX_CARD_BACKGROUND = [
  'radial-gradient(120% 80% at 50% 0%, rgba(255,215,0,0.10), transparent 55%)',
  'radial-gradient(150% 120% at 50% 55%, transparent 58%, rgba(0,0,0,0.42) 100%)',
  'linear-gradient(112deg, rgba(255,215,0,0.09), transparent 26%)',
  'linear-gradient(248deg, rgba(255,215,0,0.09), transparent 26%)',
  WM_DIAMOND,
  WM_SPADE,
  SUIT_TILE,
  BOX_BASE_GRADIENT,
].join(', ');
const BOX_CARD_BG_SIZE = 'auto, auto, auto, auto, 130px 130px, 160px 160px, 128px 128px, auto';
const BOX_CARD_BG_POS = '0 0, 0 0, 0 0, 0 0, -34px 96px, calc(100% + 44px) calc(100% - 36px), 0 0, 0 0';
const BOX_CARD_BG_REPEAT = 'no-repeat, no-repeat, no-repeat, no-repeat, no-repeat, no-repeat, repeat, no-repeat';

// Chip and reveal colours per prize, matching the wheel's slice palette so
// the boxes read as the same machine.
const PRIZE_STYLE = {
  'K5':        { bg: '#00e5ff', fg: '#06283a' },
  'K10':       { bg: '#00e676', fg: '#052e16' },
  'K20':       { bg: '#d500f9', fg: '#ffffff' },
  'K50':       { bg: '#ff6d00', fg: '#ffffff' },
  'K100':      { bg: '#ffd600', fg: '#4a3000' },
  'K200':      { bg: '#ffab00', fg: '#4a3000' },
  'K10,000':   { bg: 'linear-gradient(180deg,#ff5252,#c50e1f 55%,#7a0212)', fg: '#ffd700' },
  'TRY AGAIN': { bg: '#78909c', fg: '#eceff1' },
};
function prizeChipStyle(label, fontSize, extra) {
  const p = PRIZE_STYLE[label] || PRIZE_STYLE['TRY AGAIN'];
  return {
    background: p.bg, color: p.fg, fontWeight: 900, fontSize,
    padding: '3px 9px', borderRadius: 7, whiteSpace: 'nowrap',
    border: '1px solid rgba(0,0,0,0.35)',
    boxShadow: '0 2px 6px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.35)',
    letterSpacing: '0.02em',
    ...extra,
  };
}

// ============================================================================
// MYSTERY BOX STAGE — the alternate game's centre stage. Purely visual: the
// outcome is the server's spin result exactly as with the wheel; whichever
// box the player picks reveals it. Phases (driven by the parent):
//   intro   — the prize labels drop into the boxes (the player sees what's
//             in play, matching the wheel's slice artwork)
//   shuffle — the boxes swap positions rapidly for 4 seconds
//   pick    — boxes pulse, waiting for the tap
//   opening — chosen box wobbles while /api/spin answers
//   reveal  — chosen box opens on the result; the others show the rest
// ============================================================================
// The mystery box art: the owner-approved "A1 Polished" 3D gift box
// (picked from the design page 2026-08-28). Glossy gold with the red ribbon
// the trigger icon already uses, drawn with real depth: a receding side
// wall, a lid with a visible top surface, ribbon wrapped over every face,
// a folded bow with tails, twin gloss streaks and static sparkles. Body and
// lid are separate layers so the reveal can fly the lid up and off; gold
// light and a heap of coins burst from the opening on a win, a dark empty
// mouth on a loss. The nine copies share gradient ids; they are identical,
// so every url(#...) resolving to the first copy renders correctly.
function BoxSVG({ open, isWin, sparkle }) {
  const svgStyle = { position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', display: 'block' };
  const spk = (d, delay) => (
    <path
      d={d}
      fill="#fffbe6"
      opacity="0.5"
      style={sparkle ? { transformBox: 'fill-box', transformOrigin: '50% 50%', animation: `bwSpk 2.3s ${delay} ease-in-out infinite` } : undefined}
    />
  );
  return (
    <div style={{ position: 'absolute', left: '-3%', top: '-1%', width: '106%', height: '102%', pointerEvents: 'none' }}>
      <svg viewBox="0 0 120 116" aria-hidden="true" style={svgStyle}>
        <defs>
          <linearGradient id="bwbFront" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fde047" /><stop offset="0.55" stopColor="#eab308" /><stop offset="1" stopColor="#a16207" />
          </linearGradient>
          <linearGradient id="bwbSide" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#ca8a04" /><stop offset="1" stopColor="#7c4a0a" />
          </linearGradient>
          <linearGradient id="bwbLidF" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fef9c3" /><stop offset="0.5" stopColor="#fde047" /><stop offset="1" stopColor="#eab308" />
          </linearGradient>
          <linearGradient id="bwbLidT" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fffbe6" /><stop offset="1" stopColor="#fde68a" />
          </linearGradient>
          <linearGradient id="bwbLidS" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#eab308" /><stop offset="1" stopColor="#a16207" />
          </linearGradient>
          <linearGradient id="bwbRibF" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#f87171" /><stop offset="0.5" stopColor="#dc2626" /><stop offset="1" stopColor="#991b1b" />
          </linearGradient>
          <linearGradient id="bwbRibD" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#b91c1c" /><stop offset="1" stopColor="#7f1d1d" />
          </linearGradient>
          <linearGradient id="bwbRibT" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ef4444" /><stop offset="1" stopColor="#b91c1c" />
          </linearGradient>
          <radialGradient id="bwbCoin" cx="0.35" cy="0.3" r="0.95">
            <stop offset="0" stopColor="#fff3b0" /><stop offset="0.55" stopColor="#ffd700" /><stop offset="1" stopColor="#b8860b" />
          </radialGradient>
          <radialGradient id="bwbGlow">
            <stop offset="0" stopColor="#fff6c9" /><stop offset="0.45" stopColor="rgba(255,215,0,0.9)" /><stop offset="0.8" stopColor="rgba(255,215,0,0)" />
          </radialGradient>
        </defs>

        {/* open top: dark interior; glow + coin heap fade in on a win */}
        <path d="M10,42 L34,34 L110,34 L86,42 Z" fill="#170c03" />
        {open && isWin && (
          <g style={{ animation: 'bwBoxMouth 0.5s 0.3s ease-out both' }}>
            <ellipse cx="58" cy="38" rx="40" ry="6.5" fill="url(#bwbGlow)" />
            <circle cx="46" cy="38" r="5.5" fill="url(#bwbCoin)" stroke="#7a5a10" strokeWidth="1.3" />
            <circle cx="60" cy="36.5" r="5.5" fill="url(#bwbCoin)" stroke="#7a5a10" strokeWidth="1.3" />
            <circle cx="73" cy="38" r="5.5" fill="url(#bwbCoin)" stroke="#7a5a10" strokeWidth="1.3" />
          </g>
        )}

        {/* side wall + wrapped ribbon */}
        <path d="M86,42 L110,34 L110,96 L86,104 Z" fill="url(#bwbSide)" />
        <path d="M86,64 L110,56 L110,72 L86,80 Z" fill="url(#bwbRibD)" />
        <path d="M86,42 L110,34 L110,96 L86,104 Z" fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth="1" />

        {/* front face: seam shadow under the lid, twin gloss, ribbon */}
        <rect x="10" y="42" width="76" height="62" rx="3.5" fill="url(#bwbFront)" />
        <rect x="10" y="42" width="76" height="62" rx="3.5" fill="none" stroke="rgba(0,0,0,0.18)" strokeWidth="1" />
        <rect x="10" y="46" width="76" height="4.5" fill="rgba(0,0,0,0.14)" />
        <path d="M17,50 L27,50 L23,96 L13,96 Z" fill="rgba(255,255,255,0.3)" />
        <path d="M30,52 L34,52 L31.5,84 L27.5,84 Z" fill="rgba(255,255,255,0.18)" />
        <rect x="41" y="42" width="14" height="62" fill="url(#bwbRibF)" />
        <path d="M45,42 h2 v62 h-2 Z" fill="rgba(255,255,255,0.3)" />
        <rect x="10" y="98" width="76" height="6" rx="3" fill="rgba(0,0,0,0.22)" />
        {spk('M76,54.7 L76.99,57.01 L79,58 L76.99,58.99 L76,61.3 L75.01,58.99 L73,58 L75.01,57.01 Z', '0s')}
        {spk('M21,71.6 L21.72,73.28 L23.4,74 L21.72,74.72 L21,76.4 L20.28,74.72 L18.6,74 L20.28,73.28 Z', '0.9s')}

        {/* coins leaping out on a win, staggered after the lid flies */}
        {open && isWin && [
          { cx: 42, cy: 36, r: 5.5, fly: 'translate(-22px,-30px)', d: '0.32s' },
          { cx: 58, cy: 35, r: 5.5, fly: 'translate(2px,-38px)', d: '0.38s' },
          { cx: 72, cy: 36, r: 5.5, fly: 'translate(20px,-26px)', d: '0.44s' },
          { cx: 48, cy: 36, r: 4.2, fly: 'translate(-32px,-18px)', d: '0.35s' },
          { cx: 66, cy: 36, r: 4.2, fly: 'translate(32px,-15px)', d: '0.47s' },
        ].map((c) => (
          <circle key={c.cx} cx={c.cx} cy={c.cy} r={c.r} fill="url(#bwbCoin)" stroke="#7a5a10" strokeWidth="1"
            style={{ '--fly': c.fly, transformBox: 'fill-box', animation: `bwCoinFly 0.5s ${c.d} ease-out both` }} />
        ))}
      </svg>

      {/* lid layer: pops up and off on the reveal */}
      <div style={{ position: 'absolute', inset: 0, ...(open ? { animation: 'bwLidFly 0.6s ease-out both' } : {}) }}>
        <svg viewBox="0 0 120 116" aria-hidden="true" style={svgStyle}>
          <path d="M5,30 L29,22 L115,22 L91,30 Z" fill="url(#bwbLidT)" />
          <path d="M41,30 L65,22 L79,22 L55,30 Z" fill="url(#bwbRibT)" />
          <path d="M91,30 L115,22 L115,38 L91,46 Z" fill="url(#bwbLidS)" />
          <rect x="5" y="30" width="86" height="16" rx="2" fill="url(#bwbLidF)" />
          <rect x="5" y="30" width="86" height="16" rx="2" fill="none" stroke="rgba(0,0,0,0.18)" strokeWidth="1" />
          <rect x="41" y="30" width="14" height="16" fill="url(#bwbRibF)" />
          <path d="M45,30 h2 v16 h-2 Z" fill="rgba(255,255,255,0.3)" />
          <path d="M5,44 h86 v2 h-86 Z" fill="rgba(0,0,0,0.2)" />
          {/* bow: shadow, tails, folded loops with highlights, knot */}
          <ellipse cx="48" cy="24" rx="11" ry="2.4" fill="rgba(0,0,0,0.2)" />
          <path d="M44,22 L36.5,37 L42,37 L46,27 Z" fill="url(#bwbRibD)" />
          <path d="M52,22 L59.5,37 L54,37 L50,27 Z" fill="url(#bwbRibD)" />
          <ellipse cx="40" cy="16" rx="9.5" ry="7" transform="rotate(-18 40 16)" fill="#dc2626" />
          <ellipse cx="40" cy="16" rx="9.5" ry="7" transform="rotate(-18 40 16)" fill="none" stroke="#7f1d1d" strokeWidth="1.4" />
          <ellipse cx="41.8" cy="17.4" rx="4.8" ry="3.4" transform="rotate(-18 41.8 17.4)" fill="#991b1b" opacity="0.85" />
          <ellipse cx="37.2" cy="13.2" rx="4" ry="2.3" transform="rotate(-18 37.2 13.2)" fill="#fca5a5" opacity="0.6" />
          <ellipse cx="56" cy="16" rx="9.5" ry="7" transform="rotate(18 56 16)" fill="#dc2626" />
          <ellipse cx="56" cy="16" rx="9.5" ry="7" transform="rotate(18 56 16)" fill="none" stroke="#7f1d1d" strokeWidth="1.4" />
          <ellipse cx="54.2" cy="17.4" rx="4.8" ry="3.4" transform="rotate(18 54.2 17.4)" fill="#991b1b" opacity="0.85" />
          <ellipse cx="58.8" cy="13.2" rx="4" ry="2.3" transform="rotate(18 58.8 13.2)" fill="#fca5a5" opacity="0.6" />
          <rect x="44.2" y="15" width="7.6" height="8.4" rx="3" fill="#dc2626" stroke="#7f1d1d" strokeWidth="1.3" />
          <path d="M46.2,16 h1.6 v6.4 h-1.6 Z" fill="#fca5a5" opacity="0.55" />
          {spk('M84,23.3 L84.81,25.19 L86.7,26 L84.81,26.81 L84,28.7 L83.19,26.81 L81.3,26 L83.19,25.19 Z', '1.5s')}
        </svg>
      </div>
    </div>
  );
}

function MysteryBoxStage({ phase, chosen, reveal, onPick, onShuffle, isLowEnd }) {
  // slots[slotIndex] = box id occupying that grid cell.
  //
  // The shuffle is deliberately UNTRACKABLE, not merely fast. Players film
  // these games; anyone who could visually follow "the K10,000 box" through
  // the shuffle and then lose after picking it would have video that looks
  // like proof of cheating. So the boxes do not glide between grid cells
  // (traceable): for the whole shuffle every box continuously flies to fresh
  // random spots with a centre-heavy bias, so identical boxes cross and
  // stack over one another dozens of times. Every occlusion severs the
  // trail; by the scatter, "which box had which prize" is undefined.
  const [slots, setSlots] = useState(() => [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const [mode, setMode] = useState('grid'); // grid | scatter (orbit drives styles directly)
  const boxRefs = useRef([]);
  useEffect(() => {
    if (phase === 'intro') { setSlots([0, 1, 2, 3, 4, 5, 6, 7, 8]); setMode('grid'); }
    if (phase === 'pick') {
      // The orbit wrote positions behind React's back, so React's diff would
      // skip any box it believes unmoved. Deal a fresh random arrangement and
      // place EVERY chest on its grid cell imperatively, then sync state.
      const perm = [0, 1, 2, 3, 4, 5, 6, 7, 8];
      for (let j = perm.length - 1; j > 0; j--) {
        const k = Math.floor(Math.random() * (j + 1));
        const tv = perm[j]; perm[j] = perm[k]; perm[k] = tv;
      }
      for (let i = 0; i < 9; i++) {
        const el = boxRefs.current[i];
        if (!el) continue;
        const slot = perm.indexOf(i);
        el.style.transition = 'left 0.45s cubic-bezier(.2,.8,.3,1), top 0.45s cubic-bezier(.2,.8,.3,1)';
        el.style.left = (2.5 + (slot % 3) * 33.5) + '%';
        el.style.top = (7 + Math.floor(slot / 3) * 30) + '%';
        el.style.zIndex = '1';
      }
      setSlots(perm);
      setMode('grid');
    }
    if (phase !== 'shuffle') return undefined;
    // The shuffle: all chests whirl round the centre, accelerating to a speed
    // where frame-to-frame motion exceeds the spacing between chests — on any
    // recording that aliases (the wagon-wheel effect), so no chest can be
    // followed even in slow motion. Mid-spin the ring collapses once through
    // the centre (nine identical chests in one spot), which severs identity
    // outright. Driven per-frame via refs, same technique as the wheel; the
    // loop spins until the phase changes — no timers to race or throttle.
    let raf = null;
    let active = true;
    let angle = 0;
    let last = null;
    const t0 = performance.now();
    const R0 = 30;                         // ring radius, % of the stage
    // ~2.2 rev/s (owner asked twice for calmer; still untrackable): adjacent
    // boxes are 40° apart, so at 2.2 rev/s a 30fps recording still moves each
    // box ~26° per frame — most of the gap — and with the mid-spin collapse
    // on top, no box can be followed across frames.
    const PEAK_RPS = isLowEnd ? 1.6 : 2.2;
    const step = (now) => {
      if (!active) return;
      const t = (now - t0) / 1000;
      const dt = last === null ? 0 : Math.min(0.05, (now - last) / 1000);
      last = now;
      const rps = Math.min(PEAK_RPS, 0.6 + t * 2.0); // quick ramp to full speed
      angle += rps * 360 * dt;
      // One collapse through the centre around the midpoint of the spin.
      const collapse = Math.max(0, 1 - Math.abs(t - 1.7) / 0.35);
      const R = R0 * (1 - collapse);
      for (let i = 0; i < 9; i++) {
        const el = boxRefs.current[i];
        if (!el) continue;
        const a = (angle + i * 40) * (Math.PI / 180);
        el.style.transition = 'none';
        el.style.left = (35.5 + R * Math.cos(a)) + '%';
        el.style.top = (37 + R * 0.85 * Math.sin(a)) + '%';
        el.style.zIndex = String(Math.sin(a) > 0 ? 3 : 1);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { active = false; if (raf) cancelAnimationFrame(raf); };
  }, [phase, isLowEnd]);

  // 'ready' keeps the intro caption: the prizes are still on show, and the
  // start button no longer lives in this slot to fill it.
  const caption = (phase === 'intro' || phase === 'ready') ? 'TODAY’S PRIZES!'
    : phase === 'sink' ? 'THE PRIZES GO INTO THE BOXES…'
    : phase === 'shuffle' ? 'SHUFFLING…'
    : phase === 'pick' ? 'PICK A BOX!'
    : phase === 'opening' ? 'OPENING…'
    : phase === 'reveal' ? (reveal && reveal.isWin ? 'YOU FOUND IT!' : 'NOT THIS TIME') : '';

  // Decoy label for a non-chosen box once the reveal is on.
  const decoyFor = (id) => {
    if (!reveal) return null;
    const others = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((i) => i !== chosen);
    return reveal.decoys[others.indexOf(id)] || 'TRY AGAIN';
  };

  return (
    <div className="relative mx-auto" style={{ width: '100%', maxWidth: 370, aspectRatio: '1', marginTop: 18 }}>
      {/* Spotlight, matching the wheel's */}
      <div className="absolute pointer-events-none" style={{
        inset: '-20%',
        background: 'radial-gradient(circle at 50% 48%, rgba(200,210,230,0.15) 0%, rgba(150,160,180,0.07) 30%, transparent 60%)',
      }} />

      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((id) => {
        const slot = slots.indexOf(id);
        const col = slot % 3, row = Math.floor(slot / 3);
        const isChosen = chosen === id;
        const revealed = phase === 'reveal';
        const label = revealed ? (isChosen ? reveal.label : decoyFor(id)) : null;
        const isWinLabel = revealed && isChosen && reveal.isWin;
        // Position by shuffle mode: grid cell normally, the centre pile while
        // gathering/swirling, and a springy glide back out on scatter.
        let left = 2.5 + col * 33.5, top = 7 + row * 30;
        let trans = 'left 0.14s ease-in-out, top 0.14s ease-in-out';
        let z = isChosen ? 3 : 1;
        return (
          <button
            key={id}
            ref={(el) => { boxRefs.current[id] = el; }}
            type="button"
            onClick={() => onPick(id)}
            disabled={phase !== 'pick'}
            aria-label={'Box ' + (id + 1)}
            className="absolute"
            style={{
              width: '29%', height: '26%',
              left: left + '%',
              top: top + '%',
              transition: trans,
              cursor: phase === 'pick' ? 'pointer' : 'default',
              zIndex: z,
              background: 'transparent', border: 0, padding: 0,
            }}
          >
            <div style={{
              position: 'relative', width: '100%', height: '100%',
              ...(phase === 'pick' && !isLowEnd ? { animation: `bwBoxPulse 1.4s ${(id % 3) * 0.15}s ease-in-out infinite` } : {}),
              ...(phase === 'opening' && isChosen ? { animation: 'bwBoxWobble 0.4s ease-in-out infinite' } : {}),
              ...(revealed && isChosen ? { transform: 'scale(1.12)' } : {}),
              ...(revealed && !isChosen ? { opacity: 0.55 } : {}),
              transition: 'transform 0.25s ease-out, opacity 0.25s ease-out',
            }}>
              {/* Prize chip, coloured like its wheel slice: drops onto the box
                  and SITS there until the shuffle button sinks it inside. */}
              {(phase === 'intro' || phase === 'ready' || phase === 'sink') && (
                <div style={{
                  position: 'absolute', left: '50%', top: -10, zIndex: 4,
                  animation: phase === 'sink'
                    ? `bwBoxSink 0.5s ${(id % 3) * 0.07}s ease-in both`
                    : `bwBoxDropStay 0.9s ${(id % 9) * 0.06}s ease-out both`,
                  ...prizeChipStyle(BOX_LABELS[id], 17),
                }}>{BOX_LABELS[id]}</div>
              )}

              {/* Ground shadow */}
              <div style={{
                position: 'absolute', left: '10%', right: '10%', bottom: '-4%', height: '10%',
                background: 'radial-gradient(ellipse, rgba(0,0,0,.45) 0%, transparent 70%)',
                filter: 'blur(3px)',
              }} />

              {/* The gift box — the lid flies off when this box is the revealed pick */}
              <BoxSVG open={revealed && isChosen} isWin={isWinLabel} sparkle={phase === 'pick' && !isLowEnd} />

              {/* Reveal: gold burst behind the chosen box's prize, chips
                  coloured like their wheel slices everywhere */}
              {revealed && isChosen && (
                <div style={{
                  position: 'absolute', left: '50%', top: '40%', width: '150%', aspectRatio: '1',
                  transform: 'translate(-50%,-50%)', zIndex: 4, pointerEvents: 'none',
                  animation: 'bwBoxPop 0.4s 0.3s ease-out both',
                  background: isWinLabel
                    ? 'radial-gradient(circle, rgba(255,215,0,.55) 0%, rgba(255,215,0,.18) 45%, transparent 70%)'
                    : 'radial-gradient(circle, rgba(148,163,184,.35) 0%, transparent 65%)',
                }} />
              )}
              {revealed && label && (
                <div style={{
                  position: 'absolute', left: '50%', top: isChosen ? '30%' : '40%',
                  zIndex: 5,
                  animation: isChosen ? 'bwChipPop 0.4s 0.35s ease-out both' : 'bwBoxPop 0.5s 0.45s ease-out both',
                  ...prizeChipStyle(label, isChosen ? 19 : 12, isChosen ? { padding: '6px 14px', boxShadow: '0 4px 12px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.35)' } : { opacity: 0.9 }),
                }}>{label}</div>
              )}
            </div>
          </button>
        );
      })}

      {/* Phase caption — sits under the MYSTERY BOX header, above the boxes. */}
      <div className="absolute left-0 right-0 text-center" style={{ top: '-5%', zIndex: 6 }}>
        <span className="font-black uppercase tracking-widest" style={{
          fontSize: 14,
          color: (phase === 'pick' || phase === 'shuffle') ? '#FEF200' : 'rgba(255,255,255,0.8)',
          textShadow: '0 2px 6px rgba(0,0,0,.7)',
          ...((phase === 'pick' || phase === 'shuffle') && !isLowEnd ? { animation: 'stopFlash 0.5s ease-in-out infinite' } : {}),
        }}>{caption}</span>
      </div>

      {/* The start button, over the middle of the 3x3 grid (owner spec). The
          player starts the shuffle themselves, so they get all the time they
          want to read the prizes first. Centred on the grid's true middle —
          the cells span 2.5–98.5% across and 7–93% down — rather than on the
          stage, so it sits on the centre box however the stage is sized.
          Above every box (they top out at z-index 4) and only mounted while
          the boxes are idle, so it can never swallow a pick. */}
      {phase === 'ready' && (
        <div className="absolute" style={{
          left: '50.5%', top: '50%', transform: 'translate(-50%, -50%)', zIndex: 7,
        }}>
          <button
            type="button"
            onClick={onShuffle}
            className="font-black uppercase rounded-xl transition-all hover:scale-[1.04] active:scale-95"
            style={{
              fontSize: 15, padding: '9px 22px', color: '#fff', border: 0,
              background: 'linear-gradient(135deg, #f59e0b, #d97706)',
              boxShadow: '0 6px 18px rgba(0,0,0,.65), inset 0 1px 0 rgba(255,255,255,.35)',
              letterSpacing: '0.05em', cursor: 'pointer', whiteSpace: 'nowrap',
              ...(isLowEnd ? {} : { animation: 'playBtnPulse 2.4s ease-in-out infinite' }),
            }}
          >CLICK HERE TO PLAY</button>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// PARTICLE SYSTEM — colored shapes (no emojis)
// ============================================================================
const PARTICLE_COLORS = ['#fbbf24', '#a855f7', '#06b6d4', '#ec4899', '#22c55e'];

function useParticleSystem() {
  const canvasRef = useRef(null);
  const particlesRef = useRef([]);
  const animFrameRef = useRef(null);

  const spawnParticles = useCallback((x, y, count, config = {}) => {
    const { spread = 200, speed = 8, life = 40, gravity = 0.18, colors = PARTICLE_COLORS, size = 8 } = config;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const v = speed * (0.5 + Math.random() * 0.5);
      particlesRef.current.push({
        x, y, vx: Math.cos(angle) * v * (spread / 200), vy: Math.sin(angle) * v * (spread / 200) - 2,
        life: life + Math.random() * 15, maxLife: life + 15, gravity,
        color: colors[Math.floor(Math.random() * colors.length)],
        shape: Math.random() > 0.5 ? 'circle' : 'square',
        size: size * (0.7 + Math.random() * 0.6), rotation: Math.random() * 360, rotSpeed: (Math.random() - 0.5) * 12,
      });
    }
  }, []);

  const startLoop = useCallback(() => {
    if (animFrameRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const loop = () => {
      canvas.width = window.innerWidth; canvas.height = window.innerHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particlesRef.current = particlesRef.current.filter(p => {
        p.x += p.vx; p.y += p.vy; p.vy += p.gravity; p.vx *= 0.99; p.life--; p.rotation += p.rotSpeed;
        const alpha = Math.min(1, p.life / (p.maxLife * 0.3));
        if (alpha <= 0) return false;
        ctx.save(); ctx.globalAlpha = alpha; ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        if (p.shape === 'circle') {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        }
        ctx.restore();
        return true;
      });
      if (particlesRef.current.length > 0) animFrameRef.current = requestAnimationFrame(loop);
      else animFrameRef.current = null;
    };
    animFrameRef.current = requestAnimationFrame(loop);
  }, []);

  useEffect(() => () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current); }, []);
  return { canvasRef, spawnParticles, startLoop };
}

// ============================================================================
// MAIN WIDGET
// ============================================================================
export default function WheelWidget({ prefillUserId = null }) {
  // Screen flow: checking → needLogin | prompt → spinning → stopping → result → done
  const [screen, setScreen] = useState('checking');
  const [spinResult, setSpinResult] = useState(null);
  const [showFlash, setShowFlash] = useState(false);
  const [wheelConfetti, setWheelConfetti] = useState(false);
  const [closed, setClosed] = useState(false);
  const { canvasRef, spawnParticles, startLoop } = useParticleSystem();
  const [floatingNums, setFloatingNums] = useState([]);
  const [countUpValue, setCountUpValue] = useState(0);
  const [shaking, setShaking] = useState(false);
  const [showSlowingText, setShowSlowingText] = useState(false);
  // Which flavour of "we could not confirm your spin" to show: 'not_spun'
  // (theirs to retry), 'spent_unknown' or 'unknown' (spin gone, outcome unread).
  const [recoveryOutcome, setRecoveryOutcome] = useState(null);
  const [prizeFlash, setPrizeFlash] = useState(false);

  // Countdown to the next free spin, shown on the loss card. Hours and minutes
  // only — seconds on a fourteen-hour wait are noise and would force a re-render
  // every second for nothing. Recomputed on the minute from a pure function.
  const [resetIn, setResetIn] = useState(() => splitCountdown(msUntilNextWheelReset(Date.now())));
  useEffect(() => {
    const tick = () => setResetIn(splitCountdown(msUntilNextWheelReset(Date.now())));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  const fingerprintRef = useRef(null);
  const authTokenRef = useRef(null); // raw BwanaBet JWT, received from parent via postMessage

  // Spin refs
  const spinAngleRef = useRef(0);
  const spinFrameRef = useRef(null);
  const wheelRef = useRef(null);
  const winSegmentRef = useRef(null);
  const screenRef = useRef(screen);

  // Braking refs — immediate friction slowdown when STOP pressed
  const brakingRef = useRef(false);
  const brakingSpeedRef = useRef(0);

  // API result ref — .then() stores result here, animation loop picks it up at frame boundary
  const pendingResultRef = useRef(null);

  // Easing refs — smooth landing on target segment (set when API responds)
  const decelStartRef = useRef(null);
  const decelFromRef = useRef(0);
  const decelTotalRef = useRef(0);
  const decelDurationRef = useRef(5000);

  // Pointer physics refs
  const pointerAngleRef = useRef(0);
  const pointerVelRef = useRef(0);
  const lastPegIndexRef = useRef(-1);
  const pointerElRef = useRef(null);
  const prevWheelAngleRef = useRef(0);

  const SPIN_SPEED = 20;       // per 60fps-frame → scaled by k below so apparent speed is constant across devices
  const BRAKE_FRICTION = 0.98; // per 60fps-frame
  const FRAME_MS = 1000 / 60;  // reference frame duration

  // Spring-damper parameters (per 60fps-frame units)
  const SPRING_STIFFNESS = 0.3;
  const SPRING_DAMPING = 0.15;

  // Low-end device heuristic — reduces decorative animations for weak phones.
  // Uses hardwareConcurrency + deviceMemory when available. Set once on mount.
  const [isLowEnd] = useState(() => {
    if (typeof navigator === 'undefined') return false;
    const cores = navigator.hardwareConcurrency || 8;
    const mem = navigator.deviceMemory || 8;
    return cores <= 4 || mem <= 3;
  });

  // Which game this wheel-day shows: the wheel or the mystery boxes. Purely a
  // presentation choice — both games ride the same /api/spin outcome. The
  // rotation flips at the 09:00 CAT reset; ?game=wheel|box overrides it.
  const [game] = useState(() => {
    if (typeof window === 'undefined') return 'wheel';
    return resolveGame(window.location.search, getWheelDayClient());
  });
  // Mystery-box state: idle → intro → shuffle → pick → opening → reveal.
  const [boxPhase, setBoxPhase] = useState('idle');
  const [chosenBox, setChosenBox] = useState(null);
  const [boxReveal, setBoxReveal] = useState(null);

  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  // Keep screenRef in sync
  useEffect(() => { screenRef.current = screen; }, [screen]);

  // Count-up animation for win prize
  useEffect(() => {
    if (!spinResult || spinResult.isLoss) {
      setCountUpValue(0);
      setPrizeFlash(false);
      return;
    }
    const target = spinResult.prize.kwacha;
    const duration = 800;
    const start = performance.now();
    let raf;
    const animate = (now) => {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic for count
      setCountUpValue(Math.round(eased * target));
      if (t < 1) {
        raf = requestAnimationFrame(animate);
      } else {
        setPrizeFlash(true);
        setTimeout(() => setPrizeFlash(false), 300);
      }
    };
    raf = requestAnimationFrame(animate);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [spinResult]);

  const spawnFloatingNumber = useCallback((text, x, y, color = '#fbbf24') => {
    const id = Date.now() + Math.random();
    setFloatingNums(prev => [...prev, { id, text, x, y, color }]);
    setTimeout(() => setFloatingNums(prev => prev.filter(n => n.id !== id)), 1200);
  }, []);

  // Test mode: ?test=1 bypasses localStorage check for repeated testing
  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const isTestMode = searchParams?.get('test') === '1';
  const forceWinParam = searchParams?.get('forceWin');
  // In test mode the server uses an explicit customerId (no token); default 12345.
  const testCustomerId = (prefillUserId || '12345').toString().trim();

  // On mount: generate fingerprint, then resolve the entry screen.
  // Test mode goes straight to the prompt. Real mode waits for the parent
  // (embed.js) to postMessage the BwanaBet session token, then asks the server
  // whether today's spin is still available and reports the answer back to the
  // parent so embed.js only shows the trigger button for an available spin.
  useEffect(() => {
    const fpPromise = generateFingerprint()
      .then(fp => { fingerprintRef.current = fp; return fp; })
      .catch(() => null);

    if (isTestMode) {
      setScreen('prompt');
      window.parent.postMessage({ type: 'bwanabet-wheel-available', available: true }, '*');
      return;
    }

    let checked = false;
    const resolveAvailability = async (token) => {
      if (checked) return;
      checked = true;

      const customerId = customerIdFromToken(token);
      let available = !hasSpunToday(customerId);
      // The widget's own cache is only ever written for a genuine already-spun
      // (below, and on a real /api/spin result), so a hit here is authoritative
      // and never transient. That invariant is what makes this line correct.
      let sticky = !available;

      if (available) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
        try {
          const fp = await fpPromise;
          const res = await fetch('/api/spin-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, fingerprint: fp }),
            signal: controller.signal,
          });
          const body = await res.json().catch(() => null);
          const verdict = decideAvailability({ status: res.status, body });
          available = verdict.available;
          sticky = verdict.sticky;
        } catch {
          // Timeout or network error — fail open. /api/spin still enforces the
          // daily claim atomically, so this cannot produce a double spin.
          available = true;
          sticky = false;
        } finally {
          clearTimeout(timer);
        }
      }

      if (available) {
        setScreen('prompt');
      } else {
        // Only persist a verdict that genuinely means "you already spun today".
        // Maintenance mode and auth failures are transient and must not suppress
        // the wheel for the rest of the wheel-day.
        if (sticky) markSpun(customerId);
        setScreen('done');
      }
      window.parent.postMessage({ type: 'bwanabet-wheel-available', available, sticky, customerId }, '*');
    };

    const onMessage = (e) => {
      // Only trust a token from a known BwanaBet origin (or our own origin).
      if (!isAllowedAuthOrigin(e.origin)) {
        // Silent rejection was a blind spot: an unrecognised host origin drops
        // the token, so availability never resolves and the trigger button
        // never appears. Only warn for auth attempts — unrelated scripts on the
        // host page postMessage constantly and would drown this out.
        if (e.data?.type === 'bwanabet-auth') {
          console.warn('[wheel] auth token REJECTED from origin', e.origin,
            '- add it to ALLOWED_AUTH_ORIGINS if this is a genuine BwanaBet host');
        }
        return;
      }
      if (e.data?.type === 'bwanabet-auth' && typeof e.data.token === 'string' && e.data.token) {
        authTokenRef.current = e.data.token;
        // embed.js re-sends auth every time it re-opens the overlay (it reuses
        // the SAME iframe, never reloading it). Un-latch a prior ✕-close here so
        // re-opening shows the widget again instead of a blank iframe.
        setClosed(false);
        resolveAvailability(e.data.token);
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

  // Report uncaught client-side JS errors and promise rejections to telemetry.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onError = (e) => {
      // Benign browser noise that costs a Telegram alert and a row in the
      // shared CRM database every time it fires. "ResizeObserver loop..." is
      // the browser telling itself it deferred a notification; nothing is
      // broken and no customer sees anything. Industry error trackers filter it
      // by default for the same reason.
      if (IGNORED_WINDOW_ERRORS.some(p => (e?.message || '').includes(p))) return;
      reportClientError('window_error', e?.message || 'error', e?.filename);
    };
    const onRejection = (e) => reportClientError('unhandled_rejection', e?.reason?.message || String(e?.reason), null);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // Main animation loop — 3 phases: free spin → friction brake → easing to target
  const spinActiveRef = useRef(false);
  useEffect(() => {
    const isActive = screen === 'spinning' || screen === 'stopping';
    if (isActive && !spinActiveRef.current) {
      spinActiveRef.current = true;
      lastPegIndexRef.current = -1;
      prevWheelAngleRef.current = spinAngleRef.current;
      pointerAngleRef.current = 0;
      pointerVelRef.current = 0;
      setShowSlowingText(false);
      let cancelled = false;
      let lastTs = null;

      const loop = (timestamp) => {
        if (cancelled) return;

        // k = elapsed frames at 60fps since last tick. On 60fps phones k≈1 (legacy behavior).
        // On 30fps phones k≈2; on 20fps k≈3 — so per-second angular velocity stays constant.
        // Capped at 5 to avoid huge jumps after tab backgrounding.
        const k = lastTs === null ? 1 : Math.min(5, (timestamp - lastTs) / FRAME_MS);
        lastTs = timestamp;

        let currentAngle = spinAngleRef.current;

        // PHASE 3: EASING TO TARGET — API has responded, landing on exact segment
        if (decelStartRef.current !== null) {
          const elapsed = timestamp - decelStartRef.current;
          const t = Math.min(elapsed / decelDurationRef.current, 1);
          const progress = easeOutCubic(t);
          currentAngle = decelFromRef.current + decelTotalRef.current * progress;
          spinAngleRef.current = currentAngle;

          if (wheelRef.current) {
            wheelRef.current.style.transform = `rotate(${currentAngle}deg)`;
          }

          if (t > 0.8) setShowSlowingText(true);

          if (t >= 1) {
            // Wheel stopped — let pointer physics settle
            decelStartRef.current = null;
            const settleStart = performance.now();
            const settleLoop = () => {
              if (cancelled) return;
              pointerVelRef.current += (-SPRING_STIFFNESS * pointerAngleRef.current - SPRING_DAMPING * pointerVelRef.current);
              pointerAngleRef.current += pointerVelRef.current;
              if (pointerElRef.current) {
                pointerElRef.current.style.transform = `rotate(${pointerAngleRef.current}deg)`;
              }
              const settled = Math.abs(pointerAngleRef.current) < 0.1 && Math.abs(pointerVelRef.current) < 0.1;
              if (performance.now() - settleStart < 500 && !settled) {
                requestAnimationFrame(settleLoop);
              } else {
                pointerAngleRef.current = 0;
                pointerVelRef.current = 0;
                if (pointerElRef.current) pointerElRef.current.style.transform = 'rotate(0deg)';

                // Pause so user can see where the pointer landed before showing result
                setTimeout(() => {
                  if (cancelled) return;
                  spinActiveRef.current = false;
                  const segment = winSegmentRef.current;
                  setScreen('result');
                  setSpinResult(segment);
                  setShowSlowingText(false);
                  if (!isTestMode) ackResultShown(authTokenRef.current, segment);

                  if (segment && !segment.isLoss) {
                    setShowFlash(true);
                    setWheelConfetti(true);
                    setShaking(true);
                    setTimeout(() => setShowFlash(false), 400);
                    setTimeout(() => setWheelConfetti(false), 3000);
                    setTimeout(() => setShaking(false), 150);
                    const cx = window.innerWidth / 2, cy = window.innerHeight * 0.45;
                    const isMobile = window.innerWidth < 600;
                    spawnParticles(cx, cy, isMobile ? 12 : 25, { spread: 250, speed: 9, life: isMobile ? 25 : 40, gravity: 0.2 });
                    if (!isMobile) spawnParticles(cx, cy, 15, { spread: 180, speed: 6, life: 30, gravity: 0.15 });
                    startLoop();
                    if (segment.prize?.kwacha) spawnFloatingNumber(`+K${segment.prize.kwacha}`, cx, cy - 40, '#fbbf24');
                  }
                  spinFrameRef.current = null;
                }, 1500);
              }
            };
            requestAnimationFrame(settleLoop);
            return;
          }

        // PHASE 2: FRICTION BRAKE — STOP pressed, waiting for API response
        } else if (brakingRef.current) {
          brakingSpeedRef.current *= Math.pow(BRAKE_FRICTION, k);
          spinAngleRef.current += brakingSpeedRef.current * k;
          currentAngle = spinAngleRef.current;
          if (wheelRef.current) {
            wheelRef.current.style.transform = `rotate(${currentAngle}deg)`;
          }

          // Check if API result arrived — transition to easing AT this frame boundary
          if (pendingResultRef.current) {
            const { winIndex, data } = pendingResultRef.current;
            pendingResultRef.current = null;

            // The server is the authority on the prize amount; the segment
            // table only supplies the slice we stop on. Reading kwacha from
            // the payload keeps the displayed amount correct even if a stale
            // bundle has a different layout, and resolveLandingSegment
            // substitutes a loss slice for anything unrenderable (jackpot
            // index, out-of-range) so the wheel never crashes mid-spin.
            const landing = resolveLandingSegment(winIndex);
            const base = WHEEL_SEGMENTS[landing.index];
            // API responses say `win`; the recovery path says `won` — accept both.
            // A substituted landing means the index was unrenderable (jackpot,
            // out-of-range, stale bundle) — the whole payload is untrusted then,
            // so the claimed win is discarded too, never shown on a loss slice.
            if (landing.substituted) {
              reportClientError('impossible_segment', `index ${winIndex}`, null, null);
            }
            const isWin = !landing.substituted && Boolean(data && (data.win ?? data.won));
            winSegmentRef.current = isWin
              ? { ...base, isLoss: false, prize: { kwacha: data.prize?.kwacha ?? base.prize?.kwacha ?? 0 } }
              : { ...base, isLoss: true, prize: null };

            const segCenter = landing.index * SEG_ANGLE + SEG_ANGLE / 2;
            const jitter = (Math.random() - 0.5) * (SEG_ANGLE * 0.5);
            const targetRemainder = (360 - segCenter + jitter + 360) % 360;
            let remaining = targetRemainder - (currentAngle % 360);
            if (remaining <= 0) remaining += 360;

            // Speed-matched, but floored and capped — the wheel brakes for as
            // long as the API takes, and a slow answer used to leave it turning
            // too slowly to land this side of nineteen minutes. See
            // lib/wheelLanding.js.
            const { decelTotal, duration } = computeLanding(brakingSpeedRef.current, remaining);

            decelFromRef.current = currentAngle;
            decelTotalRef.current = decelTotal;
            decelDurationRef.current = duration;
            decelStartRef.current = timestamp; // Use rAF timestamp — exact frame boundary
            brakingRef.current = false;
          }

        // PHASE 1: FREE SPIN — constant angular velocity (time-based)
        } else {
          spinAngleRef.current += SPIN_SPEED * k;
          currentAngle = spinAngleRef.current;
          if (wheelRef.current) {
            wheelRef.current.style.transform = `rotate(${currentAngle}deg)`;
          }
        }

        // === POINTER-PEG PHYSICS ===
        const normalizedAngle = ((currentAngle % 360) + 360) % 360;
        const pegIndex = Math.floor(normalizedAngle / SEG_ANGLE);
        if (lastPegIndexRef.current >= 0 && pegIndex !== lastPegIndexRef.current) {
          // Normalize wheel-speed estimate to per-60fps-frame units so impulse thresholds stay right on any device.
          const wheelSpeed = Math.abs(currentAngle - prevWheelAngleRef.current) / Math.max(k, 0.01);
          let impulse;
          if (wheelSpeed >= 15) impulse = 2;       // full speed: tiny rapid flicks
          else if (wheelSpeed >= 5) impulse = 5;    // medium: visible bounces
          else impulse = 10;                         // near stop: big dramatic bounces
          pointerVelRef.current += impulse;
        }
        lastPegIndexRef.current = pegIndex;
        prevWheelAngleRef.current = currentAngle;

        // Spring-damper update — sub-step for large dt so spring stays stable on slow phones
        const springSteps = Math.max(1, Math.min(6, Math.round(k)));
        for (let s = 0; s < springSteps; s++) {
          pointerVelRef.current += (-SPRING_STIFFNESS * pointerAngleRef.current - SPRING_DAMPING * pointerVelRef.current);
          pointerAngleRef.current += pointerVelRef.current;
        }
        pointerAngleRef.current = Math.max(-20, Math.min(20, pointerAngleRef.current));
        if (pointerElRef.current) {
          pointerElRef.current.style.transform = `rotate(${pointerAngleRef.current}deg)`;
        }

        spinFrameRef.current = requestAnimationFrame(loop);
      };
      spinFrameRef.current = requestAnimationFrame(loop);
      return () => {
        cancelled = true;
        spinActiveRef.current = false;
        if (spinFrameRef.current) { cancelAnimationFrame(spinFrameRef.current); spinFrameRef.current = null; }
      };
    }
    if (!isActive) {
      spinActiveRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  // Start playing — identity is already established (token in real mode, test id in test mode)
  const startPlaying = useCallback(() => {
    if (game === 'box') {
      setChosenBox(null);
      setBoxReveal(null);
      setScreen('boxes');
      // The prizes drop onto the boxes and STAY until the player presses the
      // shuffle button (owner spec: give them time to actually read what is
      // in play). No auto-advance past 'ready'.
      setBoxPhase('intro');
      setTimeout(() => setBoxPhase('ready'), 2000);
      return;
    }
    setScreen('spinning');
  }, [game]);

  // The shuffle button: chips sink into the boxes, then the whirl, then pick.
  const startShuffle = useCallback(() => {
    setBoxPhase('sink');
    setTimeout(() => setBoxPhase('shuffle'), 550);
    setTimeout(() => setBoxPhase('pick'), 4550); // 0.55s sink + the 4s shuffle
  }, []);

  // Land the wheel on the spin the SERVER actually recorded.
  //
  // Used wherever /api/spin leaves us without a result we can trust: the
  // response was lost in flight, or it came back `already_spun` (which says a
  // spin exists but not what it hit). Both used to pick a random LOSS segment,
  // so a committed win was displayed as a loss and the customer never found
  // out. Now we ask, and only show what comes back.
  //
  // Drives the wheel through the same refs the happy path uses.
  //
  // `knownSpent` is set by the already_spun caller, which has the server's word
  // that a spin exists. Without it a failed recovery there would fall through to
  // the generic "try again" copy and invite a retry we already know is pointless.
  const landOnRecordedSpin = useCallback((spunCustomerId, knownSpent = false) => {
    return fetchSpinStatus(authTokenRef.current, fingerprintRef.current).then((status) => {
      const rec = classifySpinRecovery(status, NUM);
      if (rec.kind === 'recovered') {
        markSpun(spunCustomerId);
        const recLanding = resolveLandingSegment(rec.segmentIndex);
        const recBase = WHEEL_SEGMENTS[recLanding.index];
        if (recLanding.substituted) {
          reportClientError('impossible_segment', `recovery index ${rec.segmentIndex}`, null, spunCustomerId);
        }
        const recWon = !recLanding.substituted && rec.won;
        winSegmentRef.current = recWon
          ? { ...recBase, isLoss: false, prize: { kwacha: rec.prizeAmount ?? recBase.prize?.kwacha ?? 0 } }
          : { ...recBase, isLoss: true, prize: null };
        pendingResultRef.current = {
          winIndex: recLanding.index,
          data: { segmentIndex: recLanding.index, won: recWon, prize: recWon ? { kwacha: rec.prizeAmount } : null },
        };
        return;
      }
      // Nothing we can honestly land on. Stop the wheel and say so — leaving the
      // screen on 'stopping' would brake forever with no result ever arriving.
      //
      // Only `spent_unknown` is proof the spin is gone, so only it marks the
      // local cache. On `unknown` we genuinely do not know, and denying a spin
      // we cannot prove was used is the wrong way to be wrong — /api/spin
      // dedupes atomically, so a retry can never pay out twice.
      const outcome = knownSpent ? 'spent_unknown' : rec.kind;
      if (outcome === 'spent_unknown') markSpun(spunCustomerId);
      setRecoveryOutcome(outcome);
      setScreen('spinUnconfirmed');
    });
  }, []);

  // STOP — brake immediately, API call in background
  const stopWheel = useCallback(() => {
    if (screenRef.current !== 'spinning') return;
    setScreen('stopping');

    // Start friction brake IMMEDIATELY — no waiting for API
    brakingRef.current = true;
    brakingSpeedRef.current = SPIN_SPEED;

    // API call in background — when it responds, set up exact landing target.
    // Retries once on network error / server_busy (safe: server dedupes).
    const spunCustomerId = customerIdFromToken(authTokenRef.current);
    postSpinWithRetry(
      isTestMode
        ? { customerId: testCustomerId, fingerprint: fingerprintRef.current, test: true, ...(forceWinParam ? { forceWin: Number(forceWinParam) || true } : {}) }
        : { token: authTokenRef.current, fingerprint: fingerprintRef.current }
    )
      .then(res => res.json())
      .then(data => {
        if (data.error === 'already_spun') {
          markSpun(spunCustomerId);
          // A spin IS on record — go and show the one they actually got rather
          // than a random loss. This is the ordinary path for a customer who
          // retries after a dropped response, so inventing a loss here would
          // hide the very win the retry was meant to surface.
          landOnRecordedSpin(spunCustomerId, true);
          return;
        }
        if (data.error) {
          if (isTestMode) {
            // Reviewers cannot authenticate test spins — simulate locally so
            // wins are reviewable. Never reached by real traffic.
            pendingResultRef.current = simulateTestOutcome(forceWinParam);
            return;
          }
          reportClientError('spin_failed', data.error || 'unknown', null, spunCustomerId);
          // Land on a random loss segment on error too. resolveLandingSegment
          // with an invalid index always substitutes from the shared loss set,
          // which also keeps the jackpot slice out of the fallback pool.
          const fallback = resolveLandingSegment(-1);
          pendingResultRef.current = { winIndex: fallback.index, data: { segmentIndex: fallback.index, won: false, prize: 0 } };
          winSegmentRef.current = { ...WHEEL_SEGMENTS[fallback.index], isLoss: true, prize: null };
          return;
        }
        markSpun(spunCustomerId);
        // Store result — animation loop picks it up at next frame boundary
        pendingResultRef.current = { winIndex: data.segmentIndex, data };
      })
      .catch(() => {
        if (isTestMode) {
          pendingResultRef.current = simulateTestOutcome(forceWinParam);
          return;
        }
        reportClientError('spin_network_error', 'spin request failed', null, spunCustomerId);
        // The RESPONSE was lost, not necessarily the spin — /api/spin may have
        // committed it before the connection died. Ask what happened instead of
        // inventing an answer. See lib/spinRecovery.js for what each verdict
        // permits us to claim.
        landOnRecordedSpin(spunCustomerId);
      });
  }, [isTestMode, forceWinParam, testCustomerId, landOnRecordedSpin]);

  // Mystery-box result application: the same segment resolution the wheel's
  // animation loop performs, minus the physics — the chosen box opens on it.
  const applyBoxOutcome = useCallback((winIndex, data) => {
    const landing = resolveLandingSegment(winIndex);
    const base = WHEEL_SEGMENTS[landing.index];
    if (landing.substituted) {
      reportClientError('impossible_segment', `box index ${winIndex}`, null, null);
    }
    const isWin = !landing.substituted && Boolean(data && (data.win ?? data.won));
    const seg = isWin
      ? { ...base, isLoss: false, prize: { kwacha: data.prize?.kwacha ?? base.prize?.kwacha ?? 0 } }
      : { ...base, isLoss: true, prize: null };
    winSegmentRef.current = seg;
    const label = isWin ? 'K' + Number(seg.prize.kwacha).toLocaleString('en-US') : 'TRY AGAIN';
    setBoxReveal({ label, isWin, decoys: boxDecoys(label) });
    setBoxPhase('reveal');
    // Four seconds on the opened boxes (owner spec) — long enough to read
    // the chosen prize AND what the other boxes held — then the result card.
    setTimeout(() => {
      setScreen('result');
      setSpinResult(seg);
      if (!isTestMode) ackResultShown(authTokenRef.current, seg);
      if (!seg.isLoss) {
        setShowFlash(true);
        setWheelConfetti(true);
        setShaking(true);
        setTimeout(() => setShowFlash(false), 400);
        setTimeout(() => setWheelConfetti(false), 3000);
        setTimeout(() => setShaking(false), 150);
        const cx = window.innerWidth / 2, cy = window.innerHeight * 0.45;
        const small = window.innerWidth < 600;
        spawnParticles(cx, cy, small ? 12 : 25, { spread: 250, speed: 9, life: small ? 25 : 40, gravity: 0.2 });
        if (!small) spawnParticles(cx, cy, 15, { spread: 180, speed: 6, life: 30, gravity: 0.15 });
        startLoop();
        if (seg.prize?.kwacha) spawnFloatingNumber('+K' + seg.prize.kwacha, cx, cy - 40, '#fbbf24');
      }
    }, 4000);
  }, [isTestMode, spawnParticles, startLoop, spawnFloatingNumber]);

  // The box tap — the mystery-box counterpart of stopWheel: same API call,
  // same dedupe/recovery paths, different presentation.
  const chooseBox = useCallback((id) => {
    if (boxPhase !== 'pick') return;
    setChosenBox(id);
    setBoxPhase('opening');
    const spunCustomerId = customerIdFromToken(authTokenRef.current);
    // landOnRecordedSpin parks a recovered result in pendingResultRef for the
    // wheel's animation loop; there is no loop here, so collect it ourselves.
    const applyPending = () => {
      const p = pendingResultRef.current;
      if (p) {
        pendingResultRef.current = null;
        applyBoxOutcome(p.winIndex, p.data);
      }
    };
    postSpinWithRetry(
      isTestMode
        ? { customerId: testCustomerId, fingerprint: fingerprintRef.current, test: true, ...(forceWinParam ? { forceWin: Number(forceWinParam) || true } : {}) }
        : { token: authTokenRef.current, fingerprint: fingerprintRef.current }
    )
      .then(res => res.json())
      .then(data => {
        if (data.error === 'already_spun') {
          markSpun(spunCustomerId);
          landOnRecordedSpin(spunCustomerId, true).then(applyPending);
          return;
        }
        if (data.error) {
          if (isTestMode) {
            // Reviewers cannot authenticate test spins — simulate locally so
            // wins are reviewable. Never reached by real traffic.
            const sim = simulateTestOutcome(forceWinParam);
            applyBoxOutcome(sim.winIndex, sim.data);
            return;
          }
          reportClientError('spin_failed', data.error || 'unknown', null, spunCustomerId);
          const fallback = resolveLandingSegment(-1);
          applyBoxOutcome(fallback.index, { won: false });
          return;
        }
        markSpun(spunCustomerId);
        applyBoxOutcome(data.segmentIndex, data);
      })
      .catch(() => {
        if (isTestMode) {
          const sim = simulateTestOutcome(forceWinParam);
          applyBoxOutcome(sim.winIndex, sim.data);
          return;
        }
        reportClientError('spin_network_error', 'spin request failed', null, spunCustomerId);
        landOnRecordedSpin(spunCustomerId).then(applyPending);
      });
  }, [boxPhase, isTestMode, testCustomerId, forceWinParam, landOnRecordedSpin, applyBoxOutcome]);

  // CLAIM — acknowledge the result and close the widget (the near-identical
  // 'done' card only shows if the user re-opens it). Test mode loops to prompt.
  const claimPrize = useCallback(() => {
    if (!spinResult) return;
    setSpinResult(null);
    if (isTestMode) {
      setBoxPhase('idle');
      setChosenBox(null);
      setBoxReveal(null);
      setScreen('prompt');
      return;
    }
    setScreen('done');
    window.parent.postMessage({ type: 'bwanabet-wheel-close' }, '*');
  }, [spinResult, isTestMode]);

  const handleClose = useCallback(() => {
    setClosed(true);
    window.parent.postMessage({ type: 'bwanabet-wheel-close' }, '*');
  }, []);

  // Play again after a spin we could not confirm. Offered only when the server
  // has no spin on record, or when we could not find out at all — never when it
  // confirmed one. This cannot double-play: claim_spin dedupes atomically, so a
  // wrong guess here costs an `already_spun`, not a second payout.
  const retryUnconfirmedSpin = useCallback(() => {
    // The wheel was mid-brake when it gave up. These refs survive a screen
    // change, so without clearing them the retry inherits the old brake and a
    // stale landing target, and stops dead almost immediately.
    brakingRef.current = false;
    brakingSpeedRef.current = 0;
    pendingResultRef.current = null;
    winSegmentRef.current = null;
    setRecoveryOutcome(null);
    setBoxPhase('idle');
    setChosenBox(null);
    setBoxReveal(null);
    setScreen('prompt');
  }, []);

  // Notify parent when user has spun (result or done screen). Carries the
  // account this result belongs to: embed.js caches "spun today" against
  // whoever is active when the message lands, and on a shared computer the
  // logged-in account can change in between — caching it against the wrong
  // customer costs them their spin. Null in test mode, where there is no token.
  //
  // An unconfirmed spin only counts when the server CONFIRMED one is on record
  // ('spent_unknown'). Telling the parent to hide the trigger on 'not_spun' or
  // 'unknown' would burn a spin the customer may never have taken.
  useEffect(() => {
    const spent = screen === 'result' || screen === 'done'
      || (screen === 'spinUnconfirmed' && recoveryOutcome === 'spent_unknown');
    if (spent) {
      const customerId = customerIdFromToken(authTokenRef.current);
      window.parent.postMessage({ type: 'bwanabet-wheel-spun', customerId }, '*');
    }
  }, [screen, recoveryOutcome]);

  if (closed) return null;

  const WHEEL_SIZE = 320;
  const isSpinning = screen === 'spinning' || screen === 'stopping';

  // ============================================================
  // CHECKING SCREEN
  // ============================================================
  if (screen === 'checking') {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }}>
        <div className="text-gray-400 text-sm">Loading...</div>
      </div>
    );
  }

  // ============================================================
  // ALL OTHER SCREENS: prompt, spinning, stopping, result, done
  // Wheel always visible; overlays render on top
  // ============================================================
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
          {Array.from({ length: window.innerWidth < 600 ? 25 : 60 }, (_, i) => {
            const colors = ['#fbbf24','#a855f7','#06b6d4','#ec4899','#22c55e'];
            const shape = ['circle','rect'][i % 2];
            const size = 6 + Math.random() * 10;
            return (
              <div key={i} style={{
                position: 'absolute', left: `${5 + Math.random() * 90}%`, top: '-20px',
                width: shape === 'rect' ? size * 0.6 : size, height: size,
                backgroundColor: colors[i % colors.length], borderRadius: shape === 'circle' ? '50%' : '2px',
                '--drift': `${(Math.random() - 0.5) * 120}px`,
                animation: `confettiFall ${2.2 + Math.random() * 1.5}s ${Math.random() * 0.8}s cubic-bezier(0.25,0.46,0.45,0.94) both`,
              }} />
            );
          })}
        </div>
      )}

      {/* ============================================================ */}
      {/* NEED-LOGIN OVERLAY — shown when no BwanaBet session token     */}
      {/* ============================================================ */}
      {screen === 'needLogin' && (
        <div className="fixed inset-0 z-[58] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', animation: 'fadeIn 0.3s ease-out' }}>
          <div className="relative text-center px-3 py-6 rounded-2xl max-w-xs w-full mx-4" style={{
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

      {/* ============================================================ */}
      {/* SPIN COULD NOT BE CONFIRMED                                  */}
      {/* Shown instead of a fabricated loss when /api/spin gave us no */}
      {/* trustworthy result. The copy differs by how much we actually */}
      {/* know, because "your spin is safe" and "your spin is gone"    */}
      {/* are opposite instructions to the customer.                   */}
      {/* ============================================================ */}
      {screen === 'spinUnconfirmed' && (
        <div className="fixed inset-0 z-[58] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', animation: 'fadeIn 0.3s ease-out' }}>
          <div className="relative text-center px-3 py-6 rounded-2xl max-w-xs w-full mx-4" style={{
            background: 'linear-gradient(180deg, #2d3348 0%, #1e2233 40%, #1a1e2e 100%)',
            border: '3px solid #3a3f52',
            boxShadow: '0 0 80px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.06)',
          }}>
            <button type="button" onClick={handleClose}
              className="absolute top-3 right-3 z-40 w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-90"
              style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 2px 8px rgba(239,68,68,0.5)' }}>
              <X className="w-5 h-5 text-white" strokeWidth={3} />
            </button>

            {recoveryOutcome === 'spent_unknown' ? (
              <>
                <div className="text-lg font-extrabold uppercase tracking-widest mb-2 mt-4" style={{ color: 'rgba(255,255,255,0.85)', letterSpacing: '2px' }}>
                  SPIN RECORDED
                </div>
                <p className="text-gray-400 text-sm mb-4">
                  Your spin went through, but we could not load the result. If you won,
                  the prize is already on your BwanaBet account — nothing else to do.
                </p>
                <button type="button" onClick={handleClose}
                  className="w-full py-3 rounded-xl font-extrabold uppercase tracking-wider text-white transition-all hover:scale-105 active:scale-95"
                  style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 4px 14px rgba(239,68,68,0.45)', letterSpacing: '1px' }}>
                  CLOSE
                </button>
              </>
            ) : (
              <>
                <div className="text-lg font-extrabold uppercase tracking-widest mb-2 mt-4" style={{ color: 'rgba(255,255,255,0.85)', letterSpacing: '2px' }}>
                  CONNECTION PROBLEM
                </div>
                <p className="text-gray-400 text-sm mb-4">
                  {recoveryOutcome === 'not_spun'
                    ? 'We could not reach the wheel. Your spin has NOT been used — give it another go.'
                    : 'We could not confirm your spin. Try again — if it already went through, we will show you the result.'}
                </p>
                <button type="button" onClick={retryUnconfirmedSpin}
                  className="w-full py-3 rounded-xl font-extrabold uppercase tracking-wider transition-all hover:scale-105 active:scale-95"
                  style={{ background: `linear-gradient(135deg, ${BWANA_YELLOW}, #f0b400)`, color: '#1a1e2e', boxShadow: '0 4px 14px rgba(254,242,0,0.4)', letterSpacing: '1px' }}>
                  TRY AGAIN
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* PROMPT OVERLAY — wheel visible behind                        */}
      {/* ============================================================ */}
      {screen === 'prompt' && (
        <div className="fixed inset-0 z-[58] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)', animation: 'fadeIn 0.3s ease-out' }}>
          <div className="relative text-center px-3 py-6 rounded-2xl max-w-xs w-full mx-4" style={{
            background: 'linear-gradient(180deg, #2d3348 0%, #1e2233 40%, #1a1e2e 100%)',
            border: '3px solid #3a3f52',
            boxShadow: '0 0 80px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.06)',
          }}>
            {/* Close button */}
            <button type="button" onClick={handleClose}
              className="absolute top-3 right-3 z-40 w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-90"
              style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 2px 8px rgba(239,68,68,0.5)' }}>
              <X className="w-5 h-5 text-white" strokeWidth={3} />
            </button>

            {/* No brand line here: the cabinet marquee behind this card already
                reads BWANABET a few pixels above, and repeating it pushed the
                actual message down the card. Solid gold rather than the
                previous gradient fill — gradient text renders unevenly on
                low-DPI shop monitors and fails outright in a few older mobile
                browsers, leaving an invisible headline. */}
            {/* Sized to FIT, not to a nice round number. CONGRATULATIONS! is
                sixteen characters and cannot wrap, so at 34px it ran past both
                edges of a 320px card. The card's content box is ~256px on
                desktop and ~224px on a 320px phone; this clamp keeps the word
                inside both. Check it renders within the panel if you change the
                wording — a longer word will need a smaller ceiling. */}
            {/* mt-5 clears the close button: it sits at top-3 and is 36px tall,
                so it occupies the first ~48px of the card. The old layout had a
                brand line absorbing that space. */}
            {/* Measured to the card's edges rather than sized by guesswork. A
                clamp has to be tuned to the longest word and then leaves every
                shorter line undersized; FitText pushes each line to 98% of the
                available width whatever it says. */}
            <h1 className="font-black leading-[0.92] mt-5" style={{
              letterSpacing: '-0.02em',
              color: BWANA_YELLOW,
              filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
            }}><FitText max={44} fill={0.98}>CONGRATULATIONS!</FitText></h1>
            <h2 className="font-black leading-[1.0] mt-1.5 mb-5" style={{
              letterSpacing: '-0.02em',
              color: BWANA_YELLOW,
              filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
            }}><FitText max={40} fill={0.98}>YOU GET FREE BONUS!</FitText></h2>

            <button
              type="button"
              onClick={startPlaying}
              className="bw-play-pulse w-full mt-2 py-2.5 px-3 rounded-xl font-black transition-all hover:scale-[1.03] active:scale-95"
              style={{
                background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                animation: 'playBtnPulse 2.4s ease-in-out infinite',
              }}
            >
              <FitText max={58} fill={0.95}>PLAY!</FitText>
            </button>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* WIN / LOSS RESULT OVERLAY                                    */}
      {/* ============================================================ */}
      {spinResult && (
        <div className="fixed inset-0 z-[58] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', animation: 'fadeIn 0.3s ease-out' }}>
          <div className="text-center px-3 py-6 rounded-3xl max-w-xs w-full mx-4" style={{
            // Box days: the result card wears the same black casino backdrop
            // as the main card, so the takeover reads as one surface.
            background: game === 'box' ? BOX_CARD_BACKGROUND : 'linear-gradient(180deg, rgba(30,40,60,0.95), rgba(15,20,35,0.98))',
            ...(game === 'box' ? {
              backgroundSize: BOX_CARD_BG_SIZE,
              backgroundPosition: BOX_CARD_BG_POS,
              backgroundRepeat: BOX_CARD_BG_REPEAT,
            } : {}),
            border: `2px solid ${spinResult.isLoss ? 'rgba(156,163,175,0.3)' : 'rgba(251,191,36,0.3)'}`,
            boxShadow: spinResult.isLoss
              ? '0 0 60px rgba(100,100,100,0.1), 0 20px 60px rgba(0,0,0,0.5)'
              : '0 0 60px rgba(251,191,36,0.15), 0 20px 60px rgba(0,0,0,0.5)',
            animation: 'resultZoom 0.5s cubic-bezier(0.34,1.56,0.64,1) both',
          }}>
            {spinResult.isLoss ? (
              <>
                <div className="font-black uppercase mb-4" style={{ color: '#fff', fontSize: '24px', letterSpacing: '-0.01em', lineHeight: 1 }}>
                  NOT THIS TIME
                </div>
                {/* Countdown strip. The bulb runs on its top and bottom edge use
                    the same rhythm as the cabinet's marquee border, so the one
                    new element on this card is built from vocabulary the widget
                    already owns rather than imported from somewhere else. */}
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
              </>
            ) : (
              <>
                <div className="uppercase font-bold mb-2" style={{ color: '#ffd700', fontSize: '12px', letterSpacing: '3px' }}>
                  YOU WON
                </div>
                <div className="relative mb-2">
                  {prizeFlash && (
                    <div className="absolute inset-0 rounded-xl" style={{
                      background: 'radial-gradient(circle, rgba(255,215,0,0.4) 0%, transparent 70%)',
                      animation: 'fadeIn 0.1s ease-out',
                    }} />
                  )}
                  <div className="relative" style={{
                    fontSize: '48px', fontWeight: 900, color: '#ffd700',
                    textShadow: '0 0 20px rgba(255,215,0,0.5), 0 0 40px rgba(255,215,0,0.2)',
                    transform: `scale(${spinResult.prize ? 0.9 + 0.1 * Math.min(countUpValue / spinResult.prize.kwacha, 1) : 1})`,
                    transition: 'transform 0.05s ease-out',
                  }}>
                    K{countUpValue}
                  </div>
                </div>
                <p className="text-gray-400 text-xs mb-5">Prize will be credited to your account</p>
              </>
            )}
            <button
              type="button"
              onClick={claimPrize}
              className={`w-full py-2.5 px-3 rounded-xl font-black shadow-lg transition-all hover:scale-[1.03] active:scale-95 ${
                spinResult.isLoss
                  ? 'hover:brightness-110'
                  : 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 shadow-green-500/30'
              }`}
              style={spinResult.isLoss ? {
                // Domed like the wheel's hub button so it reads as part of the
                // same machine. Red matches the hub and the close control, and
                // keeps gold reserved for prizes.
                background: 'linear-gradient(180deg,#ef4444,#b91c1c)',
                border: '1px solid #f87171',
                color: '#fff',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.22), 0 3px 9px rgba(0,0,0,0.45)',
              } : { '--btn-shadow': '#065F46', '--btn-glow': 'rgba(16,185,129,0.3)', '--btn-glow2': 'rgba(16,185,129,0.15)', animation: 'collectBtnPulse 2s ease-in-out infinite' }}
            >
              <FitText max={48} fill={0.95}>{spinResult.isLoss ? 'SEE YOU TOMORROW' : 'CLAIM PRIZE!'}</FitText>
            </button>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* DONE OVERLAY — dignified, no emojis                          */}
      {/* ============================================================ */}
      {screen === 'done' && !spinResult && (
        <div className="fixed inset-0 z-[58] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', animation: 'fadeIn 0.3s ease-out' }}>
          <div className="text-center px-3 py-6 rounded-3xl max-w-xs w-full mx-4" style={{
            background: 'linear-gradient(180deg, rgba(30,40,60,0.95), rgba(15,20,35,0.98))',
            border: '2px solid rgba(156,163,175,0.3)',
            boxShadow: '0 0 60px rgba(100,100,100,0.1), 0 20px 60px rgba(0,0,0,0.5)',
            animation: 'resultZoom 0.5s cubic-bezier(0.34,1.56,0.64,1) both',
          }}>
            <div className="text-lg font-extrabold uppercase tracking-widest mb-2" style={{ color: 'rgba(255,255,255,0.7)', letterSpacing: '2px' }}>
              BETTER LUCK NEXT TIME
            </div>
            <div className="text-base font-bold uppercase tracking-widest mb-6" style={{ color: 'rgba(255,255,255,0.4)', letterSpacing: '2px' }}>
              TRY AGAIN TOMORROW
            </div>
            <button
              type="button"
              onClick={handleClose}
              className="w-full py-2.5 px-3 rounded-xl font-black shadow-lg transition-all hover:scale-[1.03] active:scale-95 bg-gradient-to-r from-gray-500 to-gray-600 hover:from-gray-600 hover:to-gray-700 shadow-gray-500/20"
            >
              <FitText max={58} fill={0.95}>GOT IT</FitText>
            </button>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* MAIN CARD                                                    */}
      {/* ============================================================ */}
      <div className="relative rounded-2xl" style={{
        width: 380, maxWidth: '95vw',
        // Box days get the quiet casino backdrop (suit tile + glow +
        // vignette, all inline — see BOX_CARD_BACKGROUND); wheel days keep
        // the plain cabinet exactly as approved.
        background: game === 'box' ? BOX_CARD_BACKGROUND : CABINET_GRADIENT,
        ...(game === 'box' ? {
          backgroundSize: BOX_CARD_BG_SIZE,
          backgroundPosition: BOX_CARD_BG_POS,
          backgroundRepeat: BOX_CARD_BG_REPEAT,
        } : {}),
        boxShadow: '0 0 80px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.06)',
        border: '3px solid #3a3f52',
        ...(shaking ? { animation: 'winShake 0.15s ease-out' } : {}),
      }}>

        {/* Marquee light dots around card border — paused during spin, reduced on low-end */}
        <div className="absolute inset-0 pointer-events-none z-30 rounded-2xl overflow-hidden">
          {Array.from({ length: isLowEnd ? 12 : 28 }, (_, i) => {
            const n = isLowEnd ? 12 : 28;
            return (
              <div key={`mt${i}`} className="absolute rounded-full" style={{
                width: 4, height: 4, top: 3, left: `${(i + 1) * (100 / (n + 1))}%`,
                background: '#fbbf24', boxShadow: isLowEnd ? '0 0 3px #fbbf24' : '0 0 4px #fbbf24, 0 0 8px #fbbf2480',
                animation: `marqueeLight 1.5s ${i * 0.08}s ease-in-out infinite`,
                animationPlayState: isSpinning ? 'paused' : 'running',
              }} />
            );
          })}
          {Array.from({ length: isLowEnd ? 12 : 28 }, (_, i) => {
            const n = isLowEnd ? 12 : 28;
            return (
              <div key={`mb${i}`} className="absolute rounded-full" style={{
                width: 4, height: 4, bottom: 3, left: `${(i + 1) * (100 / (n + 1))}%`,
                background: '#fbbf24', boxShadow: isLowEnd ? '0 0 3px #fbbf24' : '0 0 4px #fbbf24, 0 0 8px #fbbf2480',
                animation: `marqueeLight 1.5s ${(i + n / 2) * 0.08}s ease-in-out infinite`,
                animationPlayState: isSpinning ? 'paused' : 'running',
              }} />
            );
          })}
          {Array.from({ length: isLowEnd ? 8 : 18 }, (_, i) => {
            const n = isLowEnd ? 8 : 18;
            return (
              <div key={`ml${i}`} className="absolute rounded-full" style={{
                width: 4, height: 4, left: 3, top: `${(i + 1) * (100 / (n + 1))}%`,
                background: '#fbbf24', boxShadow: isLowEnd ? '0 0 3px #fbbf24' : '0 0 4px #fbbf24, 0 0 8px #fbbf2480',
                animation: `marqueeLight 1.5s ${(i + n) * 0.08}s ease-in-out infinite`,
                animationPlayState: isSpinning ? 'paused' : 'running',
              }} />
            );
          })}
          {Array.from({ length: isLowEnd ? 8 : 18 }, (_, i) => {
            const n = isLowEnd ? 8 : 18;
            return (
              <div key={`mr${i}`} className="absolute rounded-full" style={{
                width: 4, height: 4, right: 3, top: `${(i + 1) * (100 / (n + 1))}%`,
                background: '#fbbf24', boxShadow: isLowEnd ? '0 0 3px #fbbf24' : '0 0 4px #fbbf24, 0 0 8px #fbbf2480',
                animation: `marqueeLight 1.5s ${(i + n * 2.5) * 0.08}s ease-in-out infinite`,
                animationPlayState: isSpinning ? 'paused' : 'running',
              }} />
            );
          })}
        </div>

        {/* Close button */}
        <button type="button" onClick={handleClose}
          className="absolute top-3 right-3 z-40 w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-90"
          style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 2px 8px rgba(239,68,68,0.5)' }}>
          <X className="w-5 h-5 text-white" strokeWidth={3} />
        </button>

        {/* === CONTENT === */}
        <div className="relative z-10 px-4 sm:px-5 pt-4 pb-4">

          {/* Winner readerboard — simulated social proof, rules in lib/winnerTicker.js */}
          <WinnerTicker isLowEnd={isLowEnd} />

          {/* Header */}
          <div className="text-center mb-2">
            {/* BWANA_YELLOW, sampled from the logo PNG on the live site — the
                dominant colour across 72,294 of its pixels. Note the site's
                REGISTER button uses #FFF100, a shade off; this follows the
                logo, which is what the wordmark should match. */}
            <h1 className="font-black leading-[0.92]" style={{
              letterSpacing: '-0.02em',
              color: BWANA_YELLOW,
              filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
            }}><FitText max={30} fill={0.98}>BWANABET</FitText></h1>
            {/* Same brand yellow as BWANABET above it — the marquee reads as one
                unit rather than two different yellows stacked. */}
            <h1 className="font-black leading-[0.92] mt-0.5" style={{
              letterSpacing: '-0.02em',
              color: BWANA_YELLOW,
              filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
            }}><FitText max={26} fill={0.98}>{game === 'box' ? 'MYSTERY BOX' : 'SPIN AND WIN'}</FitText></h1>
          </div>

          {/* ============ GAME AREA — today's game per lib/gameRotation ============ */}
          {game === 'box' ? (
          <MysteryBoxStage phase={boxPhase} chosen={chosenBox} reveal={boxReveal} onPick={chooseBox} onShuffle={startShuffle} isLowEnd={isLowEnd} />
          ) : (
          <div className="relative mx-auto" style={{ width: '100%', maxWidth: WHEEL_SIZE + 50, aspectRatio: '1' }}>

            {/* === SPOTLIGHT behind wheel === */}
            <div className="absolute pointer-events-none" style={{
              inset: '-20%',
              background: 'radial-gradient(circle at 50% 48%, rgba(200,210,230,0.15) 0%, rgba(150,160,180,0.07) 30%, transparent 60%)',
            }} />

            {/* Sparkle accents — skipped on low-end devices */}
            {!isLowEnd && (
              <>
                <div className="absolute pointer-events-none text-white/40" style={{ top: '5%', left: '2%', fontSize: 18, animation: 'sparkle 2.5s 0.3s ease-in-out infinite' }}>&#10022;</div>
                <div className="absolute pointer-events-none text-white/30" style={{ top: '12%', right: '4%', fontSize: 14, animation: 'sparkle 2.5s 1s ease-in-out infinite' }}>&#10022;</div>
                <div className="absolute pointer-events-none text-white/25" style={{ bottom: '10%', left: '4%', fontSize: 12, animation: 'sparkle 2.5s 1.6s ease-in-out infinite' }}>&#10022;</div>
                <div className="absolute pointer-events-none text-white/35" style={{ bottom: '5%', right: '2%', fontSize: 16, animation: 'sparkle 2.5s 0.7s ease-in-out infinite' }}>&#10022;</div>
              </>
            )}

            {/* Drop shadow under wheel */}
            <div className="absolute pointer-events-none rounded-full" style={{
              left: '8%', right: '8%', bottom: '-2%', height: '12%',
              background: 'radial-gradient(ellipse, rgba(0,0,0,0.35) 0%, transparent 70%)',
              filter: 'blur(8px)',
            }} />

            {/* === CHROME FRAME === */}
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

              {/* Thick outer chrome ring — blur filter skipped on low-end (expensive) */}
              <circle cx="200" cy="200" r="194" fill="none" stroke="url(#chrome1)" strokeWidth="12" filter={isLowEnd ? undefined : 'url(#chromeGlow)'} />
              {/* Specular highlight arc — bright white sweep across upper-left chrome */}
              <path d="M 80 120 A 190 190 0 0 1 280 70" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" opacity="0.35" filter={isLowEnd ? undefined : 'url(#chromeGlow)'} />
              <path d="M 90 125 A 185 185 0 0 1 270 78" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.2" />
              {/* Dark channel for lights */}
              <circle cx="200" cy="200" r="184" fill="none" stroke="#12151f" strokeWidth="10" />
              {/* Inner chrome ring */}
              <circle cx="200" cy="200" r="176" fill="none" stroke="url(#chrome2)" strokeWidth="6" />
              {/* Inner chrome specular */}
              <path d="M 95 140 A 170 170 0 0 1 260 90" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.18" />
              {/* Dark inner edge */}
              <circle cx="200" cy="200" r="171" fill="none" stroke="#1a1e2e" strokeWidth="2" />

              {/* === CHASING LIGHTS === hidden during spin (GPU-heavy) and on low-end devices */}
              {!isSpinning && !isLowEnd && Array.from({ length: 36 }, (_, i) => {
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
              {/* Low-end fallback: static dim lights, no animation, no filter */}
              {isLowEnd && Array.from({ length: 18 }, (_, i) => {
                const deg = i * 20 - 90;
                const lR = 184;
                const lx = 200 + lR * Math.cos(deg * Math.PI / 180);
                const ly = 200 + lR * Math.sin(deg * Math.PI / 180);
                const colors = ['#fbbf24','#ec4899','#a855f7','#22c55e','#3b82f6','#f97316'];
                return (
                  <circle key={`ol-${i}`} cx={lx} cy={ly} r="3.5" fill={colors[i % colors.length]} opacity="0.7" />
                );
              })}

              {/* Gold pegs at segment dividers — SMIL pulse skipped on low-end */}
              {WHEEL_SEGMENTS.map((_, i) => {
                const a = i * SEG_ANGLE - 90;
                const px = 200 + 175 * Math.cos(a * Math.PI / 180);
                const py = 200 + 175 * Math.sin(a * Math.PI / 180);
                return (
                  <g key={`peg${i}`}>
                    <circle cx={px} cy={py} r="5" fill="#1a1e2e" stroke="#b8860b" strokeWidth="1.2" />
                    <circle cx={px} cy={py} r="3" fill="#fbbf24">
                      {isSpinning && !isLowEnd && <animate attributeName="opacity" values="1;0.3;1" dur={`${0.3 + (i % 3) * 0.12}s`} repeatCount="indefinite" />}
                    </circle>
                  </g>
                );
              })}
            </svg>

            {/* === POINTER — JS-driven spring physics === */}
            <div className="absolute z-30" style={{ top: -4, left: '50%', transform: 'translateX(-50%)' }}>
              <div ref={pointerElRef} style={{ transformOrigin: '20px 12px', willChange: 'transform' }}>
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
            </div>

            {/* === SPINNING WHEEL === */}
            <div
              ref={wheelRef}
              className="absolute rounded-full overflow-hidden"
              style={{
                top: '7%', left: '7%', right: '7%', bottom: '7%',
                willChange: 'transform',  // always on → stays on its own GPU compositor layer
                backfaceVisibility: 'hidden',
              }}
            >
              <svg viewBox="0 0 300 300" className="w-full h-full">
                <defs>
                  {/* Gloss — light top-lit sheen, no bottom darkening */}
                  <linearGradient id="segGloss" x1="50%" y1="0%" x2="50%" y2="100%">
                    <stop offset="0%" stopColor="#fff" stopOpacity="0.1" />
                    <stop offset="40%" stopColor="#fff" stopOpacity="0.02" />
                    <stop offset="100%" stopColor="#000" stopOpacity="0" />
                  </linearGradient>
                  {/* Center glow — soft convex dome illusion */}
                  <radialGradient id="innerGlow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#fff" stopOpacity="0.2" />
                    <stop offset="15%" stopColor="#fff" stopOpacity="0.08" />
                    <stop offset="30%" stopColor="#fff" stopOpacity="0" />
                    <stop offset="100%" stopColor="#000" stopOpacity="0" />
                  </radialGradient>
                  {/* Rim darkening — edges recede for depth */}
                  <radialGradient id="rimDarken" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#000" stopOpacity="0" />
                    <stop offset="75%" stopColor="#000" stopOpacity="0" />
                    <stop offset="90%" stopColor="#000" stopOpacity="0.1" />
                    <stop offset="100%" stopColor="#000" stopOpacity="0.2" />
                  </radialGradient>
                  {/* Directional light — subtle upper-left highlight */}
                  <radialGradient id="dirLight" cx="35%" cy="30%" r="65%">
                    <stop offset="0%" stopColor="#fff" stopOpacity="0.06" />
                    <stop offset="50%" stopColor="#fff" stopOpacity="0" />
                    <stop offset="100%" stopColor="#000" stopOpacity="0.04" />
                  </radialGradient>
                  {/* Rim highlight — thin specular at outer edge */}
                  <radialGradient id="rimLight" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#000" stopOpacity="0" />
                    <stop offset="92%" stopColor="#000" stopOpacity="0" />
                    <stop offset="97%" stopColor="#fff" stopOpacity="0.04" />
                    <stop offset="100%" stopColor="#fff" stopOpacity="0.06" />
                  </radialGradient>
                  {/* Jackpot — deep-to-bright red, lit from the rim like a marquee */}
                  <radialGradient id="jackpotGrad" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#7a0212" />
                    <stop offset="55%" stopColor="#c50e1f" />
                    <stop offset="85%" stopColor="#ff1744" />
                    <stop offset="100%" stopColor="#ff5252" />
                  </radialGradient>
                  {/* Jackpot shimmer — bright band that sweeps the slice */}
                  <linearGradient id="jackpotSheen" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#fff" stopOpacity="0" />
                    <stop offset="50%" stopColor="#ffd700" stopOpacity="0.45" />
                    <stop offset="100%" stopColor="#fff" stopOpacity="0" />
                  </linearGradient>
                </defs>

                {/* Segments */}
                {WHEEL_SEGMENTS.map((seg, i) => {
                  const sA = i * SEG_ANGLE - 90;
                  const eA = sA + SEG_ANGLE;
                  const s = { x: 150 + 148 * Math.cos(sA * Math.PI / 180), y: 150 + 148 * Math.sin(sA * Math.PI / 180) };
                  const e = { x: 150 + 148 * Math.cos(eA * Math.PI / 180), y: 150 + 148 * Math.sin(eA * Math.PI / 180) };
                  const path = `M 150 150 L ${s.x} ${s.y} A 148 148 0 0 1 ${e.x} ${e.y} Z`;
                  if (seg.isJackpot) {
                    // Marquee treatment: red radial gradient, gold rim, and a
                    // pulsing gold sheen (SMIL skipped on low-end devices).
                    return (
                      <g key={seg.id}>
                        <path d={path} fill="url(#jackpotGrad)" />
                        <path d={path} fill="url(#jackpotSheen)" opacity="0.35">
                          {!isLowEnd && <animate attributeName="opacity" values="0.1;0.55;0.1" dur="1.6s" repeatCount="indefinite" />}
                        </path>
                        <path d={path} fill="none" stroke="#ffd700" strokeWidth="2.5">
                          {!isLowEnd && <animate attributeName="stroke-opacity" values="1;0.45;1" dur="1.6s" repeatCount="indefinite" />}
                        </path>
                        <path d={path} fill="url(#segGloss)" />
                      </g>
                    );
                  }
                  return (
                    <g key={seg.id}>
                      <path d={path} fill={seg.color} />
                      <path d={path} fill="url(#segGloss)" />
                    </g>
                  );
                })}

                {/* Dividers */}
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

                {/* Subtle 3D depth overlays */}
                <circle cx="150" cy="150" r="148" fill="url(#innerGlow)" />
                <circle cx="150" cy="150" r="148" fill="url(#rimDarken)" />

                {/* ARC PATHS for prize text (baseline faces center) */}
                {WHEEL_SEGMENTS.map((seg, i) => {
                  if (seg.isLoss) return null;
                  const r = 118;
                  const startDeg = i * SEG_ANGLE - 90;
                  const endDeg = startDeg + SEG_ANGLE;
                  const s = { x: 150 + r * Math.cos(startDeg * Math.PI / 180), y: 150 + r * Math.sin(startDeg * Math.PI / 180) };
                  const e = { x: 150 + r * Math.cos(endDeg * Math.PI / 180), y: 150 + r * Math.sin(endDeg * Math.PI / 180) };
                  return <path key={`arc${i}`} id={`segArc${i}`} d={`M ${s.x} ${s.y} A ${r} ${r} 0 0 1 ${e.x} ${e.y}`} fill="none" />;
                })}

                {/* TEXT LABELS */}
                {WHEEL_SEGMENTS.map((seg, i) => {
                  const midAngle = i * SEG_ANGLE - 90 + SEG_ANGLE / 2;
                  if (seg.isJackpot) {
                    // Checked BEFORE isLoss: the jackpot is loss-classed for
                    // result handling but keeps its marquee label.
                    return (
                      <g key={`t${i}`} transform={`rotate(${midAngle}, 150, 150)`}>
                        <text x={150 + 102} y={150 - 8} textAnchor="middle" dominantBaseline="central"
                          fill="#ffd700" fontSize="15" fontWeight="900" fontFamily="var(--font-brand), 'Arial Narrow', Arial, sans-serif"
                          stroke="rgba(0,0,0,0.75)" strokeWidth="3" paintOrder="stroke" letterSpacing="0.5">
                          K10,000
                        </text>
                        <text x={150 + 102} y={150 + 8} textAnchor="middle" dominantBaseline="central"
                          fill="#fff" fontSize="10" fontWeight="900" fontFamily="var(--font-brand), 'Arial Narrow', Arial, sans-serif"
                          stroke="rgba(0,0,0,0.75)" strokeWidth="2.5" paintOrder="stroke" letterSpacing="2">
                          JACKPOT
                        </text>
                      </g>
                    );
                  }
                  if (seg.isLoss) {
                    return (
                      <g key={`t${i}`} transform={`rotate(${midAngle}, 150, 150)`}>
                        <text x={150 + 100} y={150 - 7} textAnchor="middle" dominantBaseline="central"
                          fill="white" fontSize="11" fontWeight="900" fontFamily="var(--font-brand), 'Arial Narrow', Arial, sans-serif"
                          stroke="rgba(0,0,0,0.6)" strokeWidth="2.5" paintOrder="stroke" letterSpacing="0.3">
                          TRY AGAIN
                        </text>
                        <text x={150 + 100} y={150 + 7} textAnchor="middle" dominantBaseline="central"
                          fill="white" fontSize="11" fontWeight="900" fontFamily="var(--font-brand), 'Arial Narrow', Arial, sans-serif"
                          stroke="rgba(0,0,0,0.6)" strokeWidth="2.5" paintOrder="stroke" letterSpacing="0.3">
                          TOMORROW
                        </text>
                      </g>
                    );
                  }
                  return (
                    <text key={`t${i}`} fill="white" fontSize="17" fontWeight="900" fontFamily="var(--font-brand), 'Arial Narrow', Arial, sans-serif"
                      stroke="rgba(0,0,0,0.6)" strokeWidth="2.5" paintOrder="stroke" letterSpacing="1">
                      <textPath href={`#segArc${i}`} startOffset="50%" textAnchor="middle">
                        {seg.label}
                      </textPath>
                    </text>
                  );
                })}
              </svg>
            </div>

            {/* === CENTER HUB with STOP button === */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20" style={{ width: '30%', height: '30%' }}>
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
                <circle cx="45" cy="45" r="44" fill="none" stroke="url(#hubChrome)" strokeWidth="5"
                  style={screen === 'spinning' ? { animation: 'hubRingPulse 0.4s ease-in-out infinite' } : {}} />
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
                {/* Two stacked lines so the label fills the round hub. On one
                    line "PRESS STOP" would have to shrink to fit the circle's
                    width and would read smaller than the old "STOP" did.
                    Solid fill rather than the previous gradient: gradient text
                    renders unevenly at this size on low-DPI shop monitors and
                    disappears entirely in a few older mobile browsers. */}
                <span className={`font-black leading-[0.88] text-center tracking-tight ${screen !== 'spinning' ? 'opacity-40' : ''}`} style={{
                  // Bounded by the hub's circle, not by its bounding box: text
                  // near the top and bottom of a round button runs out of width
                  // long before the square would. Two lines at this size clear
                  // the curve; going much larger clips on the diagonal.
                  fontSize: 'clamp(17px, 5.6vw, 26px)',
                  color: '#ff5f5f',
                  textShadow: '0 2px 4px rgba(0,0,0,0.95), 0 0 12px rgba(239,68,68,0.45)',
                  ...(screen === 'spinning' ? { animation: 'stopFlash 0.4s ease-in-out infinite' } : {}),
                }}>PRESS<br />STOP</span>
              </button>
            </div>
          </div>
          )}

          {/* House promo. Read while the wheel is still turning — the one moment
              the customer is looking at the screen with nothing else to do.
              Gold on the two words carrying the promise only; a fully gold line
              would compete with the prize segments and spend the colour. */}
          <div className="text-center" style={{ borderTop: '1px solid #3a3f52', marginTop: '14px', paddingTop: '13px' }}>
            <div className="font-black uppercase" style={{ fontSize: '15px', color: '#fff', lineHeight: 1.2, letterSpacing: '0.01em' }}>
              WIN CASH <span style={{ color: '#ffd700' }}>EVERYDAY</span><br />WHEN YOU DEPOSIT!
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
