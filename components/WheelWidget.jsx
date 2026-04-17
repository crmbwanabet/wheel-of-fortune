'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { X, Sparkles } from 'lucide-react';
import { generateFingerprint } from '@/lib/fingerprint';

// ============================================================================
// DATA — 10 segments: K10, K20, K50, K100, K200, Try Again Tomorrow ×5
// ============================================================================
const WHEEL_SEGMENTS = [
  { id: 1,  label: 'K10',                prize: { kwacha: 10 },  color: '#00e5ff', isLoss: false },
  { id: 2,  label: 'Try Again Tomorrow', prize: null,            color: '#78909c', isLoss: true },
  { id: 3,  label: 'K50',                prize: { kwacha: 50 },  color: '#d500f9', isLoss: false },
  { id: 4,  label: 'Try Again Tomorrow', prize: null,            color: '#78909c', isLoss: true },
  { id: 5,  label: 'K200',               prize: { kwacha: 200 }, color: '#ffd600', isLoss: false },
  { id: 6,  label: 'Try Again Tomorrow', prize: null,            color: '#78909c', isLoss: true },
  { id: 7,  label: 'K20',                prize: { kwacha: 20 },  color: '#00e676', isLoss: false },
  { id: 8,  label: 'Try Again Tomorrow', prize: null,            color: '#78909c', isLoss: true },
  { id: 9,  label: 'K100',               prize: { kwacha: 100 }, color: '#ff6d00', isLoss: false },
  { id: 10, label: 'Try Again Tomorrow', prize: null,            color: '#78909c', isLoss: true },
];

const NUM = WHEEL_SEGMENTS.length;
const SEG_ANGLE = 360 / NUM;

// ============================================================================
// LOCALSTORAGE — 6am CAT reset
// ============================================================================
const STORAGE_KEY = 'bwanabet_wheel_spin';

function getWheelDayClient() {
  const now = new Date();
  const catMs = now.getTime() + (2 * 60 * 60 * 1000);
  const catDate = new Date(catMs);
  if (catDate.getUTCHours() < 6) {
    catDate.setUTCDate(catDate.getUTCDate() - 1);
  }
  return catDate.toISOString().split('T')[0];
}

function hasSpunToday() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return false;
    const { day } = JSON.parse(stored);
    return day === getWheelDayClient();
  } catch { return false; }
}

function markSpun() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ day: getWheelDayClient() }));
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
  // Screen flow: checking → prompt → spinning → stopping → result → done
  const [screen, setScreen] = useState('checking');
  const [customerId, setCustomerId] = useState(prefillUserId || '');
  const [validationError, setValidationError] = useState('');
  const [validating, setValidating] = useState(false);
  const [spinResult, setSpinResult] = useState(null);
  const [showFlash, setShowFlash] = useState(false);
  const [wheelConfetti, setWheelConfetti] = useState(false);
  const [closed, setClosed] = useState(false);
  const { canvasRef, spawnParticles, startLoop } = useParticleSystem();
  const [floatingNums, setFloatingNums] = useState([]);
  const [countUpValue, setCountUpValue] = useState(0);
  const [shaking, setShaking] = useState(false);
  const [showSlowingText, setShowSlowingText] = useState(false);
  const [prizeFlash, setPrizeFlash] = useState(false);

  const fingerprintRef = useRef(null);

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

  const SPIN_SPEED = 20;       // fast free spin
  const BRAKE_FRICTION = 0.98; // per-frame friction when braking (before API responds)

  // Spring-damper parameters (per-frame units)
  const SPRING_STIFFNESS = 0.3;
  const SPRING_DAMPING = 0.15;

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

  // On mount: check localStorage + generate fingerprint
  useEffect(() => {
    generateFingerprint().then(fp => { fingerprintRef.current = fp; }).catch(() => {});

    if (!isTestMode && hasSpunToday()) {
      setScreen('done');
    } else {
      setScreen('prompt');
    }
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

      const loop = (timestamp) => {
        if (cancelled) return;

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
          brakingSpeedRef.current *= BRAKE_FRICTION;
          spinAngleRef.current += brakingSpeedRef.current;
          currentAngle = spinAngleRef.current;
          if (wheelRef.current) {
            wheelRef.current.style.transform = `rotate(${currentAngle}deg)`;
          }

          // Check if API result arrived — transition to easing AT this frame boundary
          if (pendingResultRef.current) {
            const { winIndex, data } = pendingResultRef.current;
            pendingResultRef.current = null;

            winSegmentRef.current = WHEEL_SEGMENTS[winIndex];

            const segCenter = winIndex * SEG_ANGLE + SEG_ANGLE / 2;
            const jitter = (Math.random() - 0.5) * (SEG_ANGLE * 0.5);
            const targetRemainder = (360 - segCenter + jitter + 360) % 360;
            let remaining = targetRemainder - (currentAngle % 360);
            if (remaining <= 0) remaining += 360;

            const currentSpeed = brakingSpeedRef.current;
            const extraRotations = currentSpeed > 12 ? 4 : currentSpeed > 6 ? 3 : 2;
            const decelTotal = extraRotations * 360 + remaining;
            // Speed-matched duration with 5s minimum so wheel always decelerates visibly
            const duration = Math.max(5000, decelTotal * 50 / currentSpeed);

            decelFromRef.current = currentAngle;
            decelTotalRef.current = decelTotal;
            decelDurationRef.current = duration;
            decelStartRef.current = timestamp; // Use rAF timestamp — exact frame boundary
            brakingRef.current = false;
          }

        // PHASE 1: FREE SPIN — constant speed
        } else {
          spinAngleRef.current += SPIN_SPEED;
          currentAngle = spinAngleRef.current;
          if (wheelRef.current) {
            wheelRef.current.style.transform = `rotate(${currentAngle}deg)`;
          }
        }

        // === POINTER-PEG PHYSICS ===
        const normalizedAngle = ((currentAngle % 360) + 360) % 360;
        const pegIndex = Math.floor(normalizedAngle / SEG_ANGLE);
        if (lastPegIndexRef.current >= 0 && pegIndex !== lastPegIndexRef.current) {
          const wheelSpeed = Math.abs(currentAngle - prevWheelAngleRef.current);
          let impulse;
          if (wheelSpeed >= 15) impulse = 2;       // full speed: tiny rapid flicks
          else if (wheelSpeed >= 5) impulse = 5;    // medium: visible bounces
          else impulse = 10;                         // near stop: big dramatic bounces
          pointerVelRef.current += impulse;
        }
        lastPegIndexRef.current = pegIndex;
        prevWheelAngleRef.current = currentAngle;

        // Spring-damper update
        pointerVelRef.current += (-SPRING_STIFFNESS * pointerAngleRef.current - SPRING_DAMPING * pointerVelRef.current);
        pointerAngleRef.current += pointerVelRef.current;
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

  // STOP — brake immediately, API call in background
  const stopWheel = useCallback(() => {
    if (screenRef.current !== 'spinning') return;
    setScreen('stopping');

    // Start friction brake IMMEDIATELY — no waiting for API
    brakingRef.current = true;
    brakingSpeedRef.current = SPIN_SPEED;

    // API call in background — when it responds, set up exact landing target
    fetch('/api/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId: customerId.trim(), fingerprint: fingerprintRef.current, test: isTestMode, ...(forceWinParam ? { forceWin: Number(forceWinParam) || true } : {}) }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.error === 'already_spun') {
          markSpun();
          // Land on a random loss segment — let wheel decelerate naturally
          const lossIndices = WHEEL_SEGMENTS.map((s, i) => s.isLoss ? i : -1).filter(i => i >= 0);
          const randomLoss = lossIndices[Math.floor(Math.random() * lossIndices.length)];
          pendingResultRef.current = { winIndex: randomLoss, data: { segmentIndex: randomLoss, won: false, prize: 0 } };
          winSegmentRef.current = WHEEL_SEGMENTS[randomLoss];
          return;
        }
        if (data.error) {
          // Land on a random loss segment on error too
          const lossIndices = WHEEL_SEGMENTS.map((s, i) => s.isLoss ? i : -1).filter(i => i >= 0);
          const randomLoss = lossIndices[Math.floor(Math.random() * lossIndices.length)];
          pendingResultRef.current = { winIndex: randomLoss, data: { segmentIndex: randomLoss, won: false, prize: 0 } };
          winSegmentRef.current = WHEEL_SEGMENTS[randomLoss];
          return;
        }
        markSpun();
        // Store result — animation loop picks it up at next frame boundary
        pendingResultRef.current = { winIndex: data.segmentIndex, data };
      })
      .catch(() => {
        // Land on a random loss segment on network error
        const lossIndices = WHEEL_SEGMENTS.map((s, i) => s.isLoss ? i : -1).filter(i => i >= 0);
        const randomLoss = lossIndices[Math.floor(Math.random() * lossIndices.length)];
        pendingResultRef.current = { winIndex: randomLoss, data: { segmentIndex: randomLoss, won: false, prize: 0 } };
        winSegmentRef.current = WHEEL_SEGMENTS[randomLoss];
      });
  }, [customerId]);

  // CLAIM — transition to done (or back to prompt in test mode)
  const claimPrize = useCallback(() => {
    if (!spinResult) return;
    const wasWin = !spinResult.isLoss;
    setSpinResult(null);
    setScreen(isTestMode ? 'prompt' : 'done');
    if (wasWin) {
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      spawnParticles(cx, cy, 20, { spread: 300, speed: 10, life: 35, gravity: 0.22 });
      startLoop();
    }
  }, [spinResult, spawnParticles, startLoop]);

  const handleClose = useCallback(() => {
    setClosed(true);
    window.parent.postMessage({ type: 'bwanabet-wheel-close' }, '*');
  }, []);

  // Notify parent when user has spun (result or done screen)
  useEffect(() => {
    if (screen === 'result' || screen === 'done') {
      window.parent.postMessage({ type: 'bwanabet-wheel-spun' }, '*');
    }
  }, [screen]);

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
      {/* PROMPT OVERLAY — wheel visible behind                        */}
      {/* ============================================================ */}
      {screen === 'prompt' && (
        <div className="fixed inset-0 z-[58] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)', animation: 'fadeIn 0.3s ease-out' }}>
          <div className="relative text-center p-8 rounded-2xl max-w-xs w-full mx-4" style={{
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

            <h1 className="text-3xl font-black mb-1" style={{
              background: 'linear-gradient(180deg, #ffeaa0 0%, #ffd700 30%, #ff9500 70%, #cc7000 100%)',
              WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
              filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
            }}>SPIN & WIN</h1>
            <p className="text-white text-sm mb-5">Enter your BwanaBet ID to play</p>

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
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* WIN / LOSS RESULT OVERLAY                                    */}
      {/* ============================================================ */}
      {spinResult && (
        <div className="fixed inset-0 z-[58] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', animation: 'fadeIn 0.3s ease-out' }}>
          <div className="text-center p-8 rounded-3xl max-w-xs w-full mx-4" style={{
            background: 'linear-gradient(180deg, rgba(30,40,60,0.95), rgba(15,20,35,0.98))',
            border: `2px solid ${spinResult.isLoss ? 'rgba(156,163,175,0.3)' : 'rgba(251,191,36,0.3)'}`,
            boxShadow: spinResult.isLoss
              ? '0 0 60px rgba(100,100,100,0.1), 0 20px 60px rgba(0,0,0,0.5)'
              : '0 0 60px rgba(251,191,36,0.15), 0 20px 60px rgba(0,0,0,0.5)',
            animation: 'resultZoom 0.5s cubic-bezier(0.34,1.56,0.64,1) both',
          }}>
            {spinResult.isLoss ? (
              <>
                <div className="text-lg font-extrabold uppercase tracking-widest mb-2" style={{ color: 'rgba(255,255,255,0.7)', letterSpacing: '2px' }}>
                  BETTER LUCK NEXT TIME
                </div>
                <div className="text-base font-bold uppercase tracking-widest mb-6" style={{ color: 'rgba(255,255,255,0.4)', letterSpacing: '2px' }}>
                  TRY AGAIN TOMORROW
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
              className={`w-full py-3.5 rounded-xl font-bold text-lg shadow-lg transition-all hover:scale-[1.03] active:scale-95 ${
                spinResult.isLoss
                  ? 'bg-gradient-to-r from-gray-500 to-gray-600 hover:from-gray-600 hover:to-gray-700 shadow-gray-500/20'
                  : 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 shadow-green-500/30'
              }`}
              style={spinResult.isLoss ? {} : { '--btn-shadow': '#065F46', '--btn-glow': 'rgba(16,185,129,0.3)', '--btn-glow2': 'rgba(16,185,129,0.15)', animation: 'collectBtnPulse 2s ease-in-out infinite' }}
            >
              {spinResult.isLoss ? 'GOT IT' : 'Claim Prize!'}
            </button>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* DONE OVERLAY — dignified, no emojis                          */}
      {/* ============================================================ */}
      {screen === 'done' && !spinResult && (
        <div className="fixed inset-0 z-[58] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', animation: 'fadeIn 0.3s ease-out' }}>
          <div className="text-center p-8 rounded-3xl max-w-xs w-full mx-4" style={{
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
              className="w-full py-3.5 rounded-xl font-bold text-lg shadow-lg transition-all hover:scale-[1.03] active:scale-95 bg-gradient-to-r from-gray-500 to-gray-600 hover:from-gray-600 hover:to-gray-700 shadow-gray-500/20"
            >
              GOT IT
            </button>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* MAIN CARD                                                    */}
      {/* ============================================================ */}
      <div className="relative rounded-2xl" style={{
        width: 380, maxWidth: '95vw',
        background: 'linear-gradient(180deg, #2d3348 0%, #1e2233 40%, #1a1e2e 100%)',
        boxShadow: '0 0 80px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.06)',
        border: '3px solid #3a3f52',
        ...(shaking ? { animation: 'winShake 0.15s ease-out' } : {}),
      }}>

        {/* Marquee light dots around card border */}
        <div className="absolute inset-0 pointer-events-none z-30 rounded-2xl overflow-hidden">
          {Array.from({ length: 28 }, (_, i) => (
            <div key={`mt${i}`} className="absolute rounded-full" style={{
              width: 4, height: 4, top: 3, left: `${(i + 1) * (100 / 29)}%`,
              background: '#fbbf24', boxShadow: '0 0 4px #fbbf24, 0 0 8px #fbbf2480',
              animation: `marqueeLight 1.5s ${i * 0.05}s ease-in-out infinite`,
            }} />
          ))}
          {Array.from({ length: 28 }, (_, i) => (
            <div key={`mb${i}`} className="absolute rounded-full" style={{
              width: 4, height: 4, bottom: 3, left: `${(i + 1) * (100 / 29)}%`,
              background: '#fbbf24', boxShadow: '0 0 4px #fbbf24, 0 0 8px #fbbf2480',
              animation: `marqueeLight 1.5s ${(i + 14) * 0.05}s ease-in-out infinite`,
            }} />
          ))}
          {Array.from({ length: 18 }, (_, i) => (
            <div key={`ml${i}`} className="absolute rounded-full" style={{
              width: 4, height: 4, left: 3, top: `${(i + 1) * (100 / 19)}%`,
              background: '#fbbf24', boxShadow: '0 0 4px #fbbf24, 0 0 8px #fbbf2480',
              animation: `marqueeLight 1.5s ${(i + 28) * 0.05}s ease-in-out infinite`,
            }} />
          ))}
          {Array.from({ length: 18 }, (_, i) => (
            <div key={`mr${i}`} className="absolute rounded-full" style={{
              width: 4, height: 4, right: 3, top: `${(i + 1) * (100 / 19)}%`,
              background: '#fbbf24', boxShadow: '0 0 4px #fbbf24, 0 0 8px #fbbf2480',
              animation: `marqueeLight 1.5s ${(i + 46) * 0.05}s ease-in-out infinite`,
            }} />
          ))}
        </div>

        {/* Close button */}
        <button type="button" onClick={handleClose}
          className="absolute top-3 right-3 z-40 w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-90"
          style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 2px 8px rgba(239,68,68,0.5)' }}>
          <X className="w-5 h-5 text-white" strokeWidth={3} />
        </button>

        {/* === CONTENT === */}
        <div className="relative z-10 px-4 sm:px-5 pt-4 pb-4">

          {/* Header */}
          <div className="flex items-start justify-between mb-2">
            <div>
              <div className="mb-1">
                <span className="text-xs font-black tracking-[0.3em] text-white">BWANABET</span>
              </div>
              <h1 className="text-4xl sm:text-[42px] font-black tracking-tight leading-[0.85]" style={{
                background: 'linear-gradient(180deg, #ffeaa0 0%, #ffd700 30%, #ff9500 70%, #cc7000 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
              }}>SPIN</h1>
              <div className="-mt-0.5 mb-0.5">
                <span className="text-[9px] font-bold tracking-[0.35em] text-white">A N D</span>
              </div>
              <h1 className="text-4xl sm:text-[42px] font-black tracking-tight leading-[0.85]" style={{
                background: 'linear-gradient(180deg, #ffeaa0 0%, #ffd700 30%, #ff9500 70%, #cc7000 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
              }}>WIN</h1>
            </div>
          </div>

          {/* ============ WHEEL AREA ============ */}
          <div className="relative mx-auto" style={{ width: '100%', maxWidth: WHEEL_SIZE + 50, aspectRatio: '1' }}>

            {/* === SPOTLIGHT behind wheel === */}
            <div className="absolute pointer-events-none" style={{
              inset: '-20%',
              background: 'radial-gradient(circle at 50% 48%, rgba(200,210,230,0.15) 0%, rgba(150,160,180,0.07) 30%, transparent 60%)',
            }} />

            {/* Sparkle accents */}
            <div className="absolute pointer-events-none text-white/40" style={{ top: '5%', left: '2%', fontSize: 18, animation: 'sparkle 2.5s 0.3s ease-in-out infinite' }}>&#10022;</div>
            <div className="absolute pointer-events-none text-white/30" style={{ top: '12%', right: '4%', fontSize: 14, animation: 'sparkle 2.5s 1s ease-in-out infinite' }}>&#10022;</div>
            <div className="absolute pointer-events-none text-white/25" style={{ bottom: '10%', left: '4%', fontSize: 12, animation: 'sparkle 2.5s 1.6s ease-in-out infinite' }}>&#10022;</div>
            <div className="absolute pointer-events-none text-white/35" style={{ bottom: '5%', right: '2%', fontSize: 16, animation: 'sparkle 2.5s 0.7s ease-in-out infinite' }}>&#10022;</div>

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

              {/* Thick outer chrome ring */}
              <circle cx="200" cy="200" r="194" fill="none" stroke="url(#chrome1)" strokeWidth="12" filter="url(#chromeGlow)" />
              {/* Specular highlight arc — bright white sweep across upper-left chrome */}
              <path d="M 80 120 A 190 190 0 0 1 280 70" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" opacity="0.35" filter="url(#chromeGlow)" />
              <path d="M 90 125 A 185 185 0 0 1 270 78" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.2" />
              {/* Dark channel for lights */}
              <circle cx="200" cy="200" r="184" fill="none" stroke="#12151f" strokeWidth="10" />
              {/* Inner chrome ring */}
              <circle cx="200" cy="200" r="176" fill="none" stroke="url(#chrome2)" strokeWidth="6" />
              {/* Inner chrome specular */}
              <path d="M 95 140 A 170 170 0 0 1 260 90" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.18" />
              {/* Dark inner edge */}
              <circle cx="200" cy="200" r="171" fill="none" stroke="#1a1e2e" strokeWidth="2" />

              {/* === CHASING LIGHTS === */}
              {Array.from({ length: 36 }, (_, i) => {
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

              {/* Gold pegs at segment dividers */}
              {WHEEL_SEGMENTS.map((_, i) => {
                const a = i * SEG_ANGLE - 90;
                const px = 200 + 175 * Math.cos(a * Math.PI / 180);
                const py = 200 + 175 * Math.sin(a * Math.PI / 180);
                return (
                  <g key={`peg${i}`}>
                    <circle cx={px} cy={py} r="5" fill="#1a1e2e" stroke="#b8860b" strokeWidth="1.2" />
                    <circle cx={px} cy={py} r="3" fill="#fbbf24">
                      {isSpinning && <animate attributeName="opacity" values="1;0.3;1" dur={`${0.3 + (i % 3) * 0.12}s`} repeatCount="indefinite" />}
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
                willChange: isSpinning ? 'transform' : 'auto',
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
                </defs>

                {/* Segments */}
                {WHEEL_SEGMENTS.map((seg, i) => {
                  const sA = i * SEG_ANGLE - 90;
                  const eA = sA + SEG_ANGLE;
                  const s = { x: 150 + 148 * Math.cos(sA * Math.PI / 180), y: 150 + 148 * Math.sin(sA * Math.PI / 180) };
                  const e = { x: 150 + 148 * Math.cos(eA * Math.PI / 180), y: 150 + 148 * Math.sin(eA * Math.PI / 180) };
                  const path = `M 150 150 L ${s.x} ${s.y} A 148 148 0 0 1 ${e.x} ${e.y} Z`;
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
                  if (seg.isLoss) {
                    return (
                      <g key={`t${i}`} transform={`rotate(${midAngle}, 150, 150)`}>
                        <text x={150 + 100} y={150 - 7} textAnchor="middle" dominantBaseline="central"
                          fill="white" fontSize="11" fontWeight="900" fontFamily="Arial Black, Arial, sans-serif"
                          stroke="rgba(0,0,0,0.6)" strokeWidth="2.5" paintOrder="stroke" letterSpacing="0.3">
                          TRY AGAIN
                        </text>
                        <text x={150 + 100} y={150 + 7} textAnchor="middle" dominantBaseline="central"
                          fill="white" fontSize="11" fontWeight="900" fontFamily="Arial Black, Arial, sans-serif"
                          stroke="rgba(0,0,0,0.6)" strokeWidth="2.5" paintOrder="stroke" letterSpacing="0.3">
                          TOMORROW
                        </text>
                      </g>
                    );
                  }
                  return (
                    <text key={`t${i}`} fill="white" fontSize="26" fontWeight="900" fontFamily="Arial Black, Arial, sans-serif"
                      stroke="rgba(0,0,0,0.6)" strokeWidth="3" paintOrder="stroke" letterSpacing="2">
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
                <span className={`font-black text-xl sm:text-2xl tracking-wider ${screen !== 'spinning' ? 'opacity-40' : ''}`} style={{
                  background: 'linear-gradient(180deg, #ff9999 0%, #ef4444 40%, #b91c1c 100%)',
                  WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                  filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.9))',
                  ...(screen === 'spinning' ? { animation: 'stopFlash 0.4s ease-in-out infinite' } : {}),
                }}>STOP</span>
              </button>
            </div>
          </div>

          {/* ============ BOTTOM ROW ============ */}
          <div className="flex items-center justify-center mt-2">
            {screen === 'spinning' && (
              <div className="flex items-center justify-center gap-2 text-gray-400 py-1">
                <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
                <span className="font-bold text-sm tracking-wide">Tap STOP to win!</span>
                <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
              </div>
            )}
            {screen === 'stopping' && showSlowingText && (
              <div className="flex items-center justify-center gap-2 text-gray-400 py-1" style={{ animation: 'fadeIn 0.5s ease-out' }}>
                <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
                <span className="font-bold text-sm tracking-wide">Slowing down...</span>
                <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
