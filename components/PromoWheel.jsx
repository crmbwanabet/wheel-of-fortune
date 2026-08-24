'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import '@/app/promo/promo.css';
import { PROMO_SEGMENTS, SEGMENT_DEG, landingAngle, angleAt, TOTAL_MS } from '@/lib/promoSpin';
import { readPromoSpun, writePromoSpun } from '@/lib/promoOnce';

// ============================================================================
// The wheel itself is a faithful copy of the money wheel's build
// (components/WheelWidget.jsx): same chrome frame, chasing lights, gold pegs,
// spring-physics pointer, glossy SVG slices with arc labels, and chrome hub.
// Only the slice table differs — and the free-spins slice wears the jackpot's
// red-marquee treatment because here it is the star prize. Keep the two in
// sync BY HAND; they deliberately share no runtime code.
// ============================================================================

const CONFETTI_COLORS = ['#FEF200', '#C50E1F', '#ffffff', '#F5B301', '#3ddc84'];
const MOBILE_MQ = '(max-width: 767px), (orientation: portrait)';

// Pointer spring — same constants as the money wheel (per 60fps-frame units).
const SPRING_STIFFNESS = 0.3;
const SPRING_DAMPING = 0.15;
const FRAME_MS = 1000 / 60;

// Funnel beacon. The body names the variant so events from the shared-host
// path links (/spin, /bonus) still attribute to the right site; on a real
// promo domain the server trusts the Host header instead.
function sendEvent(event, variant) {
  try {
    const body = JSON.stringify({ event, variant, isMobile: window.matchMedia(MOBILE_MQ).matches });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/promo-event', new Blob([body], { type: 'application/json' }));
    } else {
      fetch('/api/promo-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch { /* never break the page over analytics */ }
}

function Confetti() {
  const pieces = Array.from({ length: 40 }, (_, i) => ({
    x: `${(i * 37) % 100}%`,
    c: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    r: `${(i * 53) % 360}deg`,
    d: `${2.4 + (i % 5) * 0.35}s`,
    delay: `${(i % 8) * 0.15}s`,
  }));
  return (
    <div className="promo-confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <i key={i} style={{ '--x': p.x, '--c': p.c, '--r': p.r, '--d': p.d, '--delay': p.delay }} />
      ))}
    </div>
  );
}

export default function PromoWheel({ site }) {
  // idle → spinning → result (which then auto-redirects to BwanaBet)
  const [screen, setScreen] = useState('idle');
  const [isMobile, setIsMobile] = useState(true);
  const wheelRef = useRef(null);
  const pointerElRef = useRef(null);
  const rafRef = useRef(null);

  // Same low-end heuristic as the money wheel — drops the expensive SVG
  // filters and SMIL animation on weak phones.
  const [isLowEnd] = useState(() => {
    if (typeof navigator === 'undefined') return false;
    const cores = navigator.hardwareConcurrency || 8;
    const mem = navigator.deviceMemory || 8;
    return cores <= 4 || mem <= 3;
  });

  // Test mode, like the money wheel's: ?test=1 ignores the one-spin-per-visitor
  // memory (fresh spin every reload) and sends no funnel events, so design
  // reviews and demos neither get stuck on the claim screen nor inflate the
  // stats. Never affects the initial markup, so hydration stays clean.
  const [isTestMode] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('test') === '1';
  });

  // Which background to show.
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Returning visitor: they already won — go straight to the claim.
  useEffect(() => {
    if (isTestMode) return;
    sendEvent('view', site.variant);
    if (readPromoSpun(window.localStorage, site.variant)) setScreen('result');
  }, [site.variant, isTestMode]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // Silent auto-redirect (owner spec: no countdown text, no opt-out): the win
  // card holds for a beat, then the page moves on to BwanaBet by itself —
  // where embed.js sees the wof marker on the destination URL and greets the
  // visitor with the arrival popup.
  const REDIRECT_MS = 3000;
  useEffect(() => {
    if (screen !== 'result') return undefined;
    const id = setTimeout(() => {
      if (!isTestMode) sendEvent('auto_redirect', site.variant);
      window.location.assign(site.destination);
    }, REDIRECT_MS);
    return () => clearTimeout(id);
  }, [screen, site.destination, site.variant, isTestMode]);

  const spin = useCallback(() => {
    if (screen !== 'idle') return;
    setScreen('spinning');
    if (!isTestMode) {
      writePromoSpun(window.localStorage, new Date().toISOString(), site.variant);
      sendEvent('spin', site.variant);
    }
    const target = landingAngle();
    const start = performance.now();

    // Pointer-peg physics, ported from the money wheel: every divider crossing
    // kicks the pointer, a spring-damper brings it back, and the impulse grows
    // as the wheel slows so the last clicks read big and dramatic.
    let lastTs = null;
    let prevAngle = 0;
    let lastPeg = -1;
    let pAngle = 0;
    let pVel = 0;

    const frame = (now) => {
      const t = now - start;
      const a = angleAt(t, target);
      if (wheelRef.current) wheelRef.current.style.transform = `rotate(${a}deg)`;

      const k = lastTs === null ? 1 : Math.min(5, (now - lastTs) / FRAME_MS);
      lastTs = now;
      const normalized = ((a % 360) + 360) % 360;
      const pegIndex = Math.floor(normalized / SEGMENT_DEG);
      if (lastPeg >= 0 && pegIndex !== lastPeg) {
        const wheelSpeed = Math.abs(a - prevAngle) / Math.max(k, 0.01);
        if (wheelSpeed >= 15) pVel += 2;       // full speed: tiny rapid flicks
        else if (wheelSpeed >= 5) pVel += 5;   // medium: visible bounces
        else pVel += 10;                        // near stop: big dramatic bounces
      }
      lastPeg = pegIndex;
      prevAngle = a;

      const steps = Math.max(1, Math.min(6, Math.round(k)));
      for (let s = 0; s < steps; s++) {
        pVel += (-SPRING_STIFFNESS * pAngle - SPRING_DAMPING * pVel);
        pAngle += pVel;
      }
      pAngle = Math.max(-20, Math.min(20, pAngle));
      if (pointerElRef.current) pointerElRef.current.style.transform = `rotate(${pAngle}deg)`;

      if (t < TOTAL_MS) {
        rafRef.current = requestAnimationFrame(frame);
        return;
      }
      // Wheel stopped — let the pointer settle, then a beat so it is seen
      // resting on the slice before the popup.
      const settleStart = performance.now();
      const settle = () => {
        pVel += (-SPRING_STIFFNESS * pAngle - SPRING_DAMPING * pVel);
        pAngle += pVel;
        if (pointerElRef.current) pointerElRef.current.style.transform = `rotate(${pAngle}deg)`;
        const settled = Math.abs(pAngle) < 0.1 && Math.abs(pVel) < 0.1;
        if (performance.now() - settleStart < 500 && !settled) {
          rafRef.current = requestAnimationFrame(settle);
        } else {
          if (pointerElRef.current) pointerElRef.current.style.transform = 'rotate(0deg)';
          setTimeout(() => setScreen('result'), 650);
        }
      };
      rafRef.current = requestAnimationFrame(settle);
    };
    rafRef.current = requestAnimationFrame(frame);
  }, [screen, site.variant, isTestMode]);

  const bg = isMobile ? site.background.mobile : site.background.desktop;
  const isSpinning = screen === 'spinning';

  return (
    <main className="promo-root" style={{ backgroundImage: `url(${bg})` }}>
      <div className="promo-layout">
        <h1 className="promo-head">
          {site.variant === 'new'
            ? <>Spin to win <b>50 Aviator Free Spins</b></>
            : <>Your <b>50 Aviator Free Spins</b> are waiting</>}
        </h1>

        <div className="promo-wheel-wrap" aria-label="Prize wheel">

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
              <linearGradient id="pwChrome1" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#e8e8e8" />
                <stop offset="12%" stopColor="#fff" />
                <stop offset="28%" stopColor="#888" />
                <stop offset="42%" stopColor="#e8e8e8" />
                <stop offset="55%" stopColor="#fff" />
                <stop offset="68%" stopColor="#999" />
                <stop offset="82%" stopColor="#e0e0e0" />
                <stop offset="100%" stopColor="#bbb" />
              </linearGradient>
              <linearGradient id="pwChrome2" x1="100%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#ddd" />
                <stop offset="25%" stopColor="#fff" />
                <stop offset="50%" stopColor="#777" />
                <stop offset="75%" stopColor="#e0e0e0" />
                <stop offset="100%" stopColor="#bbb" />
              </linearGradient>
              <filter id="pwChromeGlow" x="-8%" y="-8%" width="116%" height="116%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <filter id="pwLightGlow" x="-150%" y="-150%" width="400%" height="400%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>

            {/* Thick outer chrome ring — blur filter skipped on low-end (expensive) */}
            <circle cx="200" cy="200" r="194" fill="none" stroke="url(#pwChrome1)" strokeWidth="12" filter={isLowEnd ? undefined : 'url(#pwChromeGlow)'} />
            {/* Specular highlight arc — bright white sweep across upper-left chrome */}
            <path d="M 80 120 A 190 190 0 0 1 280 70" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" opacity="0.35" filter={isLowEnd ? undefined : 'url(#pwChromeGlow)'} />
            <path d="M 90 125 A 185 185 0 0 1 270 78" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.2" />
            {/* Dark channel for lights */}
            <circle cx="200" cy="200" r="184" fill="none" stroke="#12151f" strokeWidth="10" />
            {/* Inner chrome ring */}
            <circle cx="200" cy="200" r="176" fill="none" stroke="url(#pwChrome2)" strokeWidth="6" />
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
              const colors = ['#fbbf24', '#ffffff', '#ec4899', '#ffffff', '#a855f7', '#ffffff', '#22c55e', '#ffffff', '#3b82f6', '#ffffff', '#f97316', '#ffffff'];
              const c = colors[i % colors.length];
              return (
                <circle key={`ol-${i}`} cx={lx} cy={ly} r="4" fill={c} filter="url(#pwLightGlow)">
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
              const colors = ['#fbbf24', '#ec4899', '#a855f7', '#22c55e', '#3b82f6', '#f97316'];
              return (
                <circle key={`ol-${i}`} cx={lx} cy={ly} r="3.5" fill={colors[i % colors.length]} opacity="0.7" />
              );
            })}

            {/* Gold pegs at segment dividers — SMIL pulse skipped on low-end */}
            {PROMO_SEGMENTS.map((_, i) => {
              const a = i * SEGMENT_DEG - 90;
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
          <div className="absolute z-30" style={{ top: '-1%', left: '50%', width: '10.8%', transform: 'translateX(-50%)' }}>
            <div ref={pointerElRef} style={{ transformOrigin: '50% 25%', willChange: 'transform' }}>
              <svg viewBox="0 0 40 48" className="w-full h-auto" style={{ filter: 'drop-shadow(0 3px 8px rgba(0,0,0,0.7))' }}>
                <defs>
                  <linearGradient id="pwPtrGold" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#ffd700" />
                    <stop offset="40%" stopColor="#b8860b" />
                    <stop offset="100%" stopColor="#ffd700" />
                  </linearGradient>
                </defs>
                <polygon points="20,46 2,16 38,16" fill="url(#pwPtrGold)" stroke="#8b6914" strokeWidth="1" />
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
              willChange: 'transform',
              backfaceVisibility: 'hidden',
            }}
          >
            <svg viewBox="0 0 300 300" className="w-full h-full">
              <defs>
                {/* Gloss — light top-lit sheen, no bottom darkening */}
                <linearGradient id="pwSegGloss" x1="50%" y1="0%" x2="50%" y2="100%">
                  <stop offset="0%" stopColor="#fff" stopOpacity="0.1" />
                  <stop offset="40%" stopColor="#fff" stopOpacity="0.02" />
                  <stop offset="100%" stopColor="#000" stopOpacity="0" />
                </linearGradient>
                {/* Center glow — soft convex dome illusion */}
                <radialGradient id="pwInnerGlow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#fff" stopOpacity="0.2" />
                  <stop offset="15%" stopColor="#fff" stopOpacity="0.08" />
                  <stop offset="30%" stopColor="#fff" stopOpacity="0" />
                  <stop offset="100%" stopColor="#000" stopOpacity="0" />
                </radialGradient>
                {/* Rim darkening — edges recede for depth */}
                <radialGradient id="pwRimDarken" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#000" stopOpacity="0" />
                  <stop offset="75%" stopColor="#000" stopOpacity="0" />
                  <stop offset="90%" stopColor="#000" stopOpacity="0.1" />
                  <stop offset="100%" stopColor="#000" stopOpacity="0.2" />
                </radialGradient>
                {/* Star prize — deep-to-bright red, lit from the rim like a marquee */}
                <radialGradient id="pwMarqueeGrad" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#7a0212" />
                  <stop offset="55%" stopColor="#c50e1f" />
                  <stop offset="85%" stopColor="#ff1744" />
                  <stop offset="100%" stopColor="#ff5252" />
                </radialGradient>
                {/* Marquee shimmer — bright band that sweeps the slice */}
                <linearGradient id="pwMarqueeSheen" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#fff" stopOpacity="0" />
                  <stop offset="50%" stopColor="#ffd700" stopOpacity="0.45" />
                  <stop offset="100%" stopColor="#fff" stopOpacity="0" />
                </linearGradient>
              </defs>

              {/* Segments */}
              {PROMO_SEGMENTS.map((seg, i) => {
                const sA = i * SEGMENT_DEG - 90;
                const eA = sA + SEGMENT_DEG;
                const s = { x: 150 + 148 * Math.cos(sA * Math.PI / 180), y: 150 + 148 * Math.sin(sA * Math.PI / 180) };
                const e = { x: 150 + 148 * Math.cos(eA * Math.PI / 180), y: 150 + 148 * Math.sin(eA * Math.PI / 180) };
                const path = `M 150 150 L ${s.x} ${s.y} A 148 148 0 0 1 ${e.x} ${e.y} Z`;
                if (seg.marquee) {
                  return (
                    <g key={`s${i}`}>
                      <path d={path} fill="url(#pwMarqueeGrad)" />
                      <path d={path} fill="url(#pwMarqueeSheen)" opacity="0.35">
                        {!isLowEnd && <animate attributeName="opacity" values="0.1;0.55;0.1" dur="1.6s" repeatCount="indefinite" />}
                      </path>
                      <path d={path} fill="none" stroke="#ffd700" strokeWidth="2.5">
                        {!isLowEnd && <animate attributeName="stroke-opacity" values="1;0.45;1" dur="1.6s" repeatCount="indefinite" />}
                      </path>
                      <path d={path} fill="url(#pwSegGloss)" />
                    </g>
                  );
                }
                return (
                  <g key={`s${i}`}>
                    <path d={path} fill={seg.color} />
                    <path d={path} fill="url(#pwSegGloss)" />
                  </g>
                );
              })}

              {/* Dividers */}
              {PROMO_SEGMENTS.map((_, i) => {
                const a = i * SEGMENT_DEG - 90;
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
              <circle cx="150" cy="150" r="148" fill="url(#pwInnerGlow)" />
              <circle cx="150" cy="150" r="148" fill="url(#pwRimDarken)" />

              {/* TEXT LABELS — every label reads along the radius (vertical
                  spokes), prizes included */}
              {PROMO_SEGMENTS.map((seg, i) => {
                const midAngle = i * SEGMENT_DEG - 90 + SEGMENT_DEG / 2;
                if (seg.marquee) {
                  // Marquee label like the money wheel's jackpot: amount in
                  // gold, the word beneath in white. textLength stretches both
                  // lines across the slice's radial band so the star prize
                  // fills its slot like the cash prizes do.
                  return (
                    <g key={`t${i}`} transform={`rotate(${midAngle}, 150, 150)`}>
                      <text x={150 + 100} y={150 - 9} textAnchor="middle" dominantBaseline="central"
                        fill="#ffd700" fontSize="17" fontWeight="900" fontFamily="var(--font-brand), 'Arial Narrow', Arial, sans-serif"
                        stroke="rgba(0,0,0,0.75)" strokeWidth="3" paintOrder="stroke" letterSpacing="0.5"
                        textLength="72" lengthAdjust="spacing">
                        50 FREE
                      </text>
                      <text x={150 + 100} y={150 + 9} textAnchor="middle" dominantBaseline="central"
                        fill="#fff" fontSize="13" fontWeight="900" fontFamily="var(--font-brand), 'Arial Narrow', Arial, sans-serif"
                        stroke="rgba(0,0,0,0.75)" strokeWidth="2.5" paintOrder="stroke" letterSpacing="2"
                        textLength="72" lengthAdjust="spacing">
                        SPINS
                      </text>
                    </g>
                  );
                }
                if (seg.isLoss) {
                  return (
                    <g key={`t${i}`} transform={`rotate(${midAngle}, 150, 150)`}>
                      <text x={150 + 100} y={150} textAnchor="middle" dominantBaseline="central"
                        fill="white" fontSize="16" fontWeight="900" fontFamily="var(--font-brand), 'Arial Narrow', Arial, sans-serif"
                        stroke="rgba(0,0,0,0.6)" strokeWidth="2.5" paintOrder="stroke" letterSpacing="2">
                        LOSE
                      </text>
                    </g>
                  );
                }
                // Prize amounts fill the slice: sized to the radial band from
                // the hub's edge to the rim, textLength evening out the short
                // labels so K20 spans the same band as K100.
                return (
                  <g key={`t${i}`} transform={`rotate(${midAngle}, 150, 150)`}>
                    <text x={150 + 100} y={150} textAnchor="middle" dominantBaseline="central"
                      fill="white" fontSize="28" fontWeight="900" fontFamily="var(--font-brand), 'Arial Narrow', Arial, sans-serif"
                      stroke="rgba(0,0,0,0.6)" strokeWidth="3" paintOrder="stroke" letterSpacing="1"
                      textLength="74" lengthAdjust="spacing">
                      {seg.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* === CENTER HUB — the SPIN button === */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20" style={{ width: '30%', height: '30%' }}>
            <svg viewBox="0 0 90 90" className="w-full h-full">
              <defs>
                <radialGradient id="pwHubSphere" cx="38%" cy="28%" r="65%">
                  <stop offset="0%" stopColor="#aaa" />
                  <stop offset="10%" stopColor="#777" />
                  <stop offset="30%" stopColor="#3a3a3a" />
                  <stop offset="55%" stopColor="#151515" />
                  <stop offset="100%" stopColor="#000" />
                </radialGradient>
                <linearGradient id="pwHubChrome" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#e8e8e8" />
                  <stop offset="15%" stopColor="#fff" />
                  <stop offset="35%" stopColor="#666" />
                  <stop offset="55%" stopColor="#fff" />
                  <stop offset="75%" stopColor="#888" />
                  <stop offset="100%" stopColor="#ccc" />
                </linearGradient>
                <radialGradient id="pwHubSpec" cx="32%" cy="22%">
                  <stop offset="0%" stopColor="#fff" stopOpacity="0.85" />
                  <stop offset="20%" stopColor="#fff" stopOpacity="0.4" />
                  <stop offset="50%" stopColor="#fff" stopOpacity="0.08" />
                  <stop offset="100%" stopColor="#fff" stopOpacity="0" />
                </radialGradient>
                <radialGradient id="pwHubRim" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor="#000" stopOpacity="0" />
                  <stop offset="75%" stopColor="#000" stopOpacity="0" />
                  <stop offset="100%" stopColor="#fff" stopOpacity="0.08" />
                </radialGradient>
              </defs>
              <circle cx="45" cy="45" r="44" fill="none" stroke="url(#pwHubChrome)" strokeWidth="5"
                style={screen === 'idle' ? { animation: 'hubRingPulse 0.4s ease-in-out infinite' } : {}} />
              <circle cx="45" cy="45" r="39" fill="url(#pwHubSphere)" />
              <circle cx="45" cy="45" r="39" fill="url(#pwHubRim)" />
              <ellipse cx="36" cy="32" rx="18" ry="14" fill="url(#pwHubSpec)" />
            </svg>
            <button
              type="button"
              onClick={screen === 'idle' ? spin : undefined}
              disabled={screen !== 'idle'}
              aria-label="Spin the wheel"
              className={`absolute inset-0 rounded-full flex items-center justify-center transition-all duration-200 ${
                screen === 'idle' ? 'hover:scale-110 active:scale-90 cursor-pointer' : 'cursor-default'
              }`}
            >
              <span className={`font-black leading-[0.88] text-center tracking-tight ${screen !== 'idle' ? 'opacity-40' : ''}`} style={{
                fontSize: 'clamp(17px, 5.6vw, 26px)',
                color: '#ff5f5f',
                textShadow: '0 2px 4px rgba(0,0,0,0.95), 0 0 12px rgba(239,68,68,0.45)',
                ...(screen === 'idle' ? { animation: 'stopFlash 0.4s ease-in-out infinite' } : {}),
              }}>SPIN</span>
            </button>
          </div>
        </div>

        <div className="promo-cta">
          <button type="button" className="promo-spin-btn" onClick={spin} disabled={screen !== 'idle'}>
            {isSpinning ? 'Spinning…' : 'Spin now'}
          </button>
        </div>
        <p className="promo-fine">Free to play. One spin per visitor. 18+. T&amp;Cs apply.</p>
      </div>

      {screen === 'result' && (
        <div className="promo-scrim" role="dialog" aria-modal="true" aria-labelledby="promo-congrats">
          {/* "Sunburst Lights" card (owner-picked): slow-turning gold rays and
              a blinking bulb frame around the red marquee, with the metallic
              gold 50 and spaced white FREE SPINS lettering. */}
          <div className="promo-modal">
            <div className="promo-rays" aria-hidden="true" />
            <div className="promo-bulbs" aria-hidden="true" />
            <Confetti />
            <h2 className="promo-winner" id="promo-congrats">Winner</h2>
            <p className="promo-fifty" aria-hidden="true">50</p>
            <p className="promo-what" aria-hidden="true">Free Spins</p>
            <p className="promo-on">
              <span className="sr-only">You&apos;ve won 50 free spins </span>
              on <b>Aviator</b>{site.variant === 'new' ? ', added when you register' : ', already in your account'}
            </p>
            <a className="promo-claim" href={site.destination} onClick={() => { if (!isTestMode) sendEvent('claim_click', site.variant); }}>
              {site.ctaText}
            </a>
            <p className="promo-sub">{site.subText}</p>
          </div>
        </div>
      )}
    </main>
  );
}
