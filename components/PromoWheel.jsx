'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import '@/app/promo/promo.css';
import { PROMO_SEGMENTS, SEGMENT_DEG, landingAngle, angleAt, TOTAL_MS } from '@/lib/promoSpin';
import { readPromoSpun, writePromoSpun } from '@/lib/promoOnce';

// Build the conic-gradient once: slice k = [k*SEG, (k+1)*SEG), starting at 12 o'clock.
const WHEEL_GRADIENT = `conic-gradient(from 0deg, ${PROMO_SEGMENTS
  .map((s, i) => `${s.color} ${i * SEGMENT_DEG}deg ${(i + 1) * SEGMENT_DEG}deg`)
  .join(', ')})`;

const CONFETTI_COLORS = ['#FEF200', '#C50E1F', '#ffffff', '#F5B301', '#3ddc84'];
const MOBILE_MQ = '(max-width: 767px), (orientation: portrait)';

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
  // idle → spinning → result → done (existing-audience "maybe later")
  const [screen, setScreen] = useState('idle');
  const [isMobile, setIsMobile] = useState(true);
  const wheelRef = useRef(null);
  const wrapRef = useRef(null);
  const rafRef = useRef(null);

  // Which background to show.
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Labels and hub scale off the wheel's rendered width via --wheel.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const set = () => el.style.setProperty('--wheel', `${el.clientWidth}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Returning visitor: they already won — go straight to the claim.
  useEffect(() => {
    sendEvent('view', site.variant);
    if (readPromoSpun(window.localStorage, site.variant)) setScreen('result');
  }, [site.variant]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  const spin = useCallback(() => {
    if (screen !== 'idle') return;
    setScreen('spinning');
    writePromoSpun(window.localStorage, new Date().toISOString(), site.variant);
    sendEvent('spin', site.variant);
    const target = landingAngle();
    const start = performance.now();
    const frame = (now) => {
      const t = now - start;
      const a = angleAt(t, target);
      if (wheelRef.current) wheelRef.current.style.transform = `rotate(${a}deg)`;
      if (t < TOTAL_MS) {
        rafRef.current = requestAnimationFrame(frame);
      } else {
        // A beat so the pointer is seen resting on the slice before the popup.
        setTimeout(() => setScreen('result'), 650);
      }
    };
    rafRef.current = requestAnimationFrame(frame);
  }, [screen]);

  const bg = isMobile ? site.background.mobile : site.background.desktop;

  return (
    <main className="promo-root" style={{ backgroundImage: `url(${bg})` }}>
      <div className="promo-layout">
        <h1 className="promo-head">
          {site.variant === 'new'
            ? <>Spin to win <b>50 Aviator Free Spins</b></>
            : <>Your <b>50 Aviator Free Spins</b> are waiting</>}
        </h1>

        <div className="promo-wheel-wrap" ref={wrapRef} aria-label="Prize wheel">
          <div className="promo-pointer" />
          <div className="promo-wheel" ref={wheelRef} style={{ background: WHEEL_GRADIENT }}>
            {PROMO_SEGMENTS.map((s, i) => {
              // Arm rotated to the slice bisector; 0deg in CSS points +x (3 o'clock),
              // our slice 0 starts at 12 o'clock, hence the -90.
              const mid = i * SEGMENT_DEG + SEGMENT_DEG / 2 - 90;
              // Arms pointing into the left half would render their text
              // upside-down; flip those so every label reads the right way up.
              const flipped = ((mid % 360) + 360) % 360 > 90 && ((mid % 360) + 360) % 360 < 270;
              return (
                <div key={i} className="promo-label-arm" style={{ transform: `rotate(${mid}deg)` }}>
                  <span className={`promo-label${flipped ? ' promo-label--flip' : ''}`} style={{ color: s.text }}>{s.label}</span>
                </div>
              );
            })}
            <div className="promo-hub">SPIN</div>
          </div>
        </div>

        <div className="promo-cta">
          <button type="button" className="promo-spin-btn" onClick={spin} disabled={screen !== 'idle'}>
            {screen === 'spinning' ? 'Spinning…' : 'Spin now'}
          </button>
        </div>
        <p className="promo-fine">Free to play. One spin per visitor. 18+. T&amp;Cs apply.</p>
      </div>

      {screen === 'result' && (
        <div className="promo-scrim" role="dialog" aria-modal="true" aria-labelledby="promo-congrats">
          <div className="promo-modal">
            <Confetti />
            <h2 id="promo-congrats">🎉 Congratulations!</h2>
            <p className="win">You&apos;ve won <b>50 Aviator Free Spins</b></p>
            <a className="promo-claim" href={site.destination} onClick={() => sendEvent('claim_click', site.variant)}>
              {site.ctaText}
            </a>
            <p className="promo-sub">{site.subText}</p>
            {site.variant === 'existing' && (
              <button type="button" className="promo-later" onClick={() => setScreen('done')}>Maybe later</button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
