'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { X, Sparkles, Trophy } from 'lucide-react';

// ============================================================================
// DATA — 8 segments, weighted distribution
// ============================================================================
const WHEEL_SEGMENTS = [
  { id: 1, label: 'K10',               prize: { kwacha: 10 },  icon: '🪙', color: '#06b6d4', isLoss: false },
  { id: 2, label: 'K50',               prize: { kwacha: 50 },  icon: '🪙', color: '#a855f7', isLoss: false },
  { id: 3, label: 'Try Again\nTomorrow', prize: null,           icon: '😢', color: '#374151', isLoss: true },
  { id: 4, label: 'K20',               prize: { kwacha: 20 },  icon: '🪙', color: '#22c55e', isLoss: false },
  { id: 5, label: 'K100',              prize: { kwacha: 100 }, icon: '💰', color: '#eab308', isLoss: false },
  { id: 6, label: 'K10',               prize: { kwacha: 10 },  icon: '🪙', color: '#ec4899', isLoss: false },
  { id: 7, label: 'Try Again\nTomorrow', prize: null,           icon: '😢', color: '#374151', isLoss: true },
  { id: 8, label: 'K20',               prize: { kwacha: 20 },  icon: '🪙', color: '#f97316', isLoss: false },
];

const NUM = WHEEL_SEGMENTS.length;
const SEG_ANGLE = 360 / NUM;

// ============================================================================
// PARTICLE SYSTEM
// ============================================================================
function useParticleSystem() {
  const canvasRef = useRef(null);
  const particlesRef = useRef([]);
  const animFrameRef = useRef(null);

  const spawnParticles = useCallback((x, y, count, config = {}) => {
    const { spread = 200, speed = 8, life = 40, gravity = 0.18, emojis = ['🪙','✨','⭐'], size = 20 } = config;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const v = speed * (0.5 + Math.random() * 0.5);
      particlesRef.current.push({
        x, y, vx: Math.cos(angle) * v * (spread / 200), vy: Math.sin(angle) * v * (spread / 200) - 2,
        life: life + Math.random() * 15, maxLife: life + 15, gravity,
        emoji: emojis[Math.floor(Math.random() * emojis.length)],
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
        ctx.font = `${p.size}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(p.emoji, 0, 0); ctx.restore();
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
export default function WheelWidget() {
  // Game phases: 'spinning' → 'stopping' → 'result'
  const [phase, setPhase] = useState('spinning');
  const [result, setResult] = useState(null);
  const [showFlash, setShowFlash] = useState(false);
  const [pointerBouncing, setPointerBouncing] = useState(true);
  const [wheelConfetti, setWheelConfetti] = useState(false);
  const [spinsLeft, setSpinsLeft] = useState(1);
  const [totalWinnings, setTotalWinnings] = useState({ kwacha: 0 });
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [closed, setClosed] = useState(false);
  const { canvasRef, spawnParticles, startLoop } = useParticleSystem();
  const [floatingNums, setFloatingNums] = useState([]);

  // Spin refs
  const spinAngleRef = useRef(0);
  const spinFrameRef = useRef(null);
  const wheelRef = useRef(null);
  // Deceleration refs
  const decelStartRef = useRef(null);   // timestamp when STOP pressed
  const decelFromRef = useRef(0);       // angle when STOP pressed
  const decelTotalRef = useRef(0);      // total degrees to travel during decel
  const winSegmentRef = useRef(null);

  const DECEL_DURATION = 3500; // 3.5 seconds
  const SPIN_SPEED = 8;       // degrees per frame at full speed

  // Ease-out cubic: fast start, gradual stop
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  const spawnFloatingNumber = useCallback((text, x, y, color = '#fbbf24') => {
    const id = Date.now() + Math.random();
    setFloatingNums(prev => [...prev, { id, text, x, y, color }]);
    setTimeout(() => setFloatingNums(prev => prev.filter(n => n.id !== id)), 1200);
  }, []);

  // Main animation loop — starts immediately on mount
  useEffect(() => {
    if (spinFrameRef.current) return;
    const loop = (timestamp) => {
      // DECELERATING — time-based easing
      if (decelStartRef.current !== null) {
        const elapsed = timestamp - decelStartRef.current;
        const t = Math.min(elapsed / DECEL_DURATION, 1);
        const progress = easeOutCubic(t);
        spinAngleRef.current = decelFromRef.current + decelTotalRef.current * progress;

        if (wheelRef.current) {
          wheelRef.current.style.transform = `rotate(${spinAngleRef.current}deg)`;
        }

        if (t >= 1) {
          // Deceleration complete — show result
          decelStartRef.current = null;
          const segment = winSegmentRef.current;
          setPhase('result');
          setPointerBouncing(false);
          setResult(segment);
          setSpinsLeft(prev => prev - 1);

          if (segment && !segment.isLoss) {
            setShowFlash(true);
            setWheelConfetti(true);
            setTimeout(() => setShowFlash(false), 400);
            setTimeout(() => setWheelConfetti(false), 3000);
            const cx = window.innerWidth / 2, cy = window.innerHeight * 0.45;
            spawnParticles(cx, cy, 25, { spread: 250, speed: 9, life: 40, gravity: 0.2, emojis: ['🪙','💰','✨','🎉'] });
            spawnParticles(cx, cy, 15, { spread: 180, speed: 6, life: 30, gravity: 0.15, emojis: ['✨','🌟','💫'] });
            startLoop();
            if (segment.prize?.kwacha) spawnFloatingNumber(`+K${segment.prize.kwacha}`, cx, cy - 40, '#fbbf24');
          }
          spinFrameRef.current = null;
          return; // stop loop
        }
      } else {
        // FREE SPINNING — constant speed
        spinAngleRef.current += SPIN_SPEED;
        if (wheelRef.current) {
          wheelRef.current.style.transform = `rotate(${spinAngleRef.current}deg)`;
        }
      }
      spinFrameRef.current = requestAnimationFrame(loop);
    };
    spinFrameRef.current = requestAnimationFrame(loop);
    return () => { if (spinFrameRef.current) { cancelAnimationFrame(spinFrameRef.current); spinFrameRef.current = null; } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // STOP — begin time-based deceleration
  const stopWheel = useCallback(() => {
    if (phase !== 'spinning') return;
    setPhase('stopping');

    // Pick a winner
    const winIndex = Math.floor(Math.random() * NUM);
    const segment = WHEEL_SEGMENTS[winIndex];
    winSegmentRef.current = segment;

    // Calculate target angle (pointer at top = 270° in wheel coordinates)
    const segCenter = winIndex * SEG_ANGLE + SEG_ANGLE / 2;
    const jitter = (Math.random() - 0.5) * (SEG_ANGLE * 0.5);
    const targetRemainder = (360 - segCenter + 270 + jitter + 360) % 360;

    const currentAngle = spinAngleRef.current;
    let remaining = targetRemainder - (currentAngle % 360);
    if (remaining <= 0) remaining += 360;
    // Add 2-3 extra full rotations for visual satisfaction
    const extraSpins = (2 + Math.floor(Math.random() * 2)) * 360;

    decelFromRef.current = currentAngle;
    decelTotalRef.current = extraSpins + remaining;
    decelStartRef.current = performance.now();
  }, [phase]);

  // CLAIM
  const claimPrize = useCallback(() => {
    if (!result) return;
    if (result.prize) {
      setTotalWinnings(prev => ({ kwacha: prev.kwacha + (result.prize.kwacha || 0) }));
    }
    setHistory(prev => [{ ...result, time: new Date().toLocaleTimeString() }, ...prev]);
    setResult(null);
    // Restart spinning if spins remain
    if (spinsLeft > 1) {
      setPhase('spinning');
      setPointerBouncing(true);
      decelStartRef.current = null;
      const loop = (timestamp) => {
        if (decelStartRef.current !== null) {
          const elapsed = timestamp - decelStartRef.current;
          const t = Math.min(elapsed / DECEL_DURATION, 1);
          spinAngleRef.current = decelFromRef.current + decelTotalRef.current * easeOutCubic(t);
          if (wheelRef.current) wheelRef.current.style.transform = `rotate(${spinAngleRef.current}deg)`;
          if (t >= 1) { spinFrameRef.current = null; return; }
        } else {
          spinAngleRef.current += SPIN_SPEED;
          if (wheelRef.current) wheelRef.current.style.transform = `rotate(${spinAngleRef.current}deg)`;
        }
        spinFrameRef.current = requestAnimationFrame(loop);
      };
      spinFrameRef.current = requestAnimationFrame(loop);
    } else {
      setPhase('done');
    }
    if (!result.isLoss) {
      const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
      spawnParticles(cx, cy, 20, { spread: 300, speed: 10, life: 35, gravity: 0.22, emojis: ['🎉','🪙','💰'] });
      startLoop();
    }
  }, [result, spawnParticles, startLoop]);

  if (closed) return null;

  const WHEEL_SIZE = 320;
  const isSpinning = phase === 'spinning' || phase === 'stopping';

  return (
    <div className="relative w-full h-screen overflow-hidden flex items-center justify-center p-3" style={{ background: 'radial-gradient(ellipse at 50% 40%, #1a2038 0%, #0c0e1a 60%, #060810 100%)' }}>

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
          {Array.from({ length: 60 }, (_, i) => {
            const colors = ['#fbbf24','#a855f7','#ec4899','#22c55e','#3b82f6','#f97316','#ef4444','#14b8a6'];
            const shape = ['circle','rect','star'][i % 3];
            const size = 6 + Math.random() * 10;
            return (
              <div key={i} style={{
                position: 'absolute', left: `${5 + Math.random() * 90}%`, top: '-20px',
                width: shape === 'rect' ? size * 0.6 : size, height: shape === 'star' ? size * 0.4 : size,
                backgroundColor: colors[i % colors.length], borderRadius: shape === 'circle' ? '50%' : '2px',
                '--drift': `${(Math.random() - 0.5) * 120}px`,
                animation: `confettiFall ${2.2 + Math.random() * 1.5}s ${Math.random() * 0.8}s cubic-bezier(0.25,0.46,0.45,0.94) both`,
              }} />
            );
          })}
        </div>
      )}

      {/* ============================================================ */}
      {/* WIN / LOSS RESULT OVERLAY                                    */}
      {/* ============================================================ */}
      {result && (
        <div className="fixed inset-0 z-[58] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)', animation: 'fadeIn 0.3s ease-out' }}>
          <div className="text-center p-8 rounded-3xl max-w-xs w-full mx-4" style={{
            background: 'linear-gradient(180deg, rgba(30,40,60,0.95), rgba(15,20,35,0.98))',
            border: `2px solid ${result.isLoss ? 'rgba(156,163,175,0.3)' : 'rgba(251,191,36,0.3)'}`,
            boxShadow: result.isLoss
              ? '0 0 60px rgba(100,100,100,0.1), 0 20px 60px rgba(0,0,0,0.5)'
              : '0 0 60px rgba(251,191,36,0.15), 0 20px 60px rgba(0,0,0,0.5)',
            animation: 'resultZoom 0.5s cubic-bezier(0.34,1.56,0.64,1) both',
          }}>
            <div className="text-6xl mb-3" style={{ animation: 'float 2s ease-in-out infinite' }}>{result.icon}</div>
            {result.isLoss ? (
              <>
                <div className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-1">Better Luck</div>
                <div className="text-2xl font-black text-gray-300 mb-5">Try Again Tomorrow</div>
              </>
            ) : (
              <>
                <div className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-1">You Won</div>
                <div className="text-3xl font-black text-yellow-400 mb-5" style={{ textShadow: '0 0 20px rgba(251,191,36,0.5)' }}>
                  K{result.prize.kwacha}
                </div>
              </>
            )}
            <button
              type="button"
              onClick={claimPrize}
              className={`w-full py-3.5 rounded-xl font-bold text-lg shadow-lg transition-all hover:scale-[1.03] active:scale-95 ${
                result.isLoss
                  ? 'bg-gradient-to-r from-gray-500 to-gray-600 hover:from-gray-600 hover:to-gray-700 shadow-gray-500/20'
                  : 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 shadow-green-500/30'
              }`}
              style={result.isLoss ? {} : { '--btn-shadow': '#065F46', '--btn-glow': 'rgba(16,185,129,0.3)', '--btn-glow2': 'rgba(16,185,129,0.15)', animation: 'collectBtnPulse 2s ease-in-out infinite' }}
            >
              {result.isLoss ? 'OK' : 'Claim Prize!'}
            </button>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* MAIN CARD                                                    */}
      {/* ============================================================ */}
      <div className="relative rounded-2xl w-full" style={{
        maxWidth: 520,
        background: 'linear-gradient(180deg, #2d3348 0%, #1e2233 40%, #1a1e2e 100%)',
        boxShadow: '0 0 80px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.06)',
        border: '3px solid #3a3f52',
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
        <button type="button" onClick={() => setClosed(true)}
          className="absolute top-3 right-3 z-40 w-9 h-9 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-90"
          style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 2px 8px rgba(239,68,68,0.5)' }}>
          <X className="w-5 h-5 text-white" strokeWidth={3} />
        </button>

        {/* === CONTENT === */}
        <div className="relative z-10 px-4 sm:px-5 pt-4 pb-4">

          {/* Header */}
          <div className="flex items-start justify-between mb-2">
            <div>
              <h1 className="text-4xl sm:text-[42px] font-black tracking-tight leading-[0.85]" style={{
                background: 'linear-gradient(180deg, #ffeaa0 0%, #ffd700 30%, #ff9500 70%, #cc7000 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
              }}>SPIN</h1>
              <div className="-mt-0.5 mb-0.5">
                <span className="text-[9px] font-bold tracking-[0.35em] text-gray-500">A N D</span>
              </div>
              <h1 className="text-4xl sm:text-[42px] font-black tracking-tight leading-[0.85]" style={{
                background: 'linear-gradient(180deg, #ffeaa0 0%, #ffd700 30%, #ff9500 70%, #cc7000 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.6))',
              }}>WIN</h1>
            </div>
            <div className="flex flex-col items-end gap-1 mt-1">
              {totalWinnings.kwacha > 0 && (
                <div className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold" style={{ background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.25)' }}>🪙 K{totalWinnings.kwacha}</div>
              )}
            </div>
          </div>

          {/* ============ WHEEL AREA ============ */}
          <div className="relative mx-auto" style={{ width: '100%', maxWidth: WHEEL_SIZE + 50, aspectRatio: '1' }}>

            {/* === SPOTLIGHT behind wheel === */}
            <div className="absolute pointer-events-none" style={{
              inset: '-20%',
              background: 'radial-gradient(circle at 50% 48%, rgba(200,210,230,0.12) 0%, rgba(150,160,180,0.06) 30%, transparent 60%)',
            }} />

            {/* Sparkle accents */}
            <div className="absolute pointer-events-none text-white/40" style={{ top: '5%', left: '2%', fontSize: 18, animation: 'sparkle 2.5s 0.3s ease-in-out infinite' }}>✦</div>
            <div className="absolute pointer-events-none text-white/30" style={{ top: '12%', right: '4%', fontSize: 14, animation: 'sparkle 2.5s 1s ease-in-out infinite' }}>✦</div>
            <div className="absolute pointer-events-none text-white/25" style={{ bottom: '10%', left: '4%', fontSize: 12, animation: 'sparkle 2.5s 1.6s ease-in-out infinite' }}>✦</div>
            <div className="absolute pointer-events-none text-white/35" style={{ bottom: '5%', right: '2%', fontSize: 16, animation: 'sparkle 2.5s 0.7s ease-in-out infinite' }}>✦</div>

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
              {/* Dark channel for lights */}
              <circle cx="200" cy="200" r="184" fill="none" stroke="#12151f" strokeWidth="10" />
              {/* Inner chrome ring */}
              <circle cx="200" cy="200" r="176" fill="none" stroke="url(#chrome2)" strokeWidth="6" />
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

            {/* === POINTER === */}
            <div className="absolute z-30" style={{
              top: -4, left: '50%', transform: 'translateX(-50%)',
              animation: pointerBouncing ? 'pointerBounce 0.15s ease-in-out infinite' : 'none',
            }}>
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

            {/* === SPINNING WHEEL === */}
            <div
              ref={wheelRef}
              className="absolute rounded-full overflow-hidden"
              style={{
                top: '13%', left: '13%', right: '13%', bottom: '13%',
                willChange: isSpinning ? 'transform' : 'auto',
              }}
            >
              <svg viewBox="0 0 300 300" className="w-full h-full">
                <defs>
                  <linearGradient id="segGloss" x1="50%" y1="0%" x2="50%" y2="100%">
                    <stop offset="0%" stopColor="#fff" stopOpacity="0.32" />
                    <stop offset="30%" stopColor="#fff" stopOpacity="0.1" />
                    <stop offset="50%" stopColor="#000" stopOpacity="0" />
                    <stop offset="100%" stopColor="#000" stopOpacity="0.28" />
                  </linearGradient>
                  <radialGradient id="segDepth" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#fff" stopOpacity="0.08" />
                    <stop offset="30%" stopColor="#000" stopOpacity="0" />
                    <stop offset="80%" stopColor="#000" stopOpacity="0.15" />
                    <stop offset="100%" stopColor="#000" stopOpacity="0.3" />
                  </radialGradient>
                  <linearGradient id="segShimmer" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#fff" stopOpacity="0" />
                    <stop offset="42%" stopColor="#fff" stopOpacity="0" />
                    <stop offset="50%" stopColor="#fff" stopOpacity="0.14" />
                    <stop offset="58%" stopColor="#fff" stopOpacity="0" />
                    <stop offset="100%" stopColor="#fff" stopOpacity="0" />
                  </linearGradient>
                  <radialGradient id="innerGlow" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#fff" stopOpacity="0.4" />
                    <stop offset="12%" stopColor="#fff" stopOpacity="0.15" />
                    <stop offset="35%" stopColor="#fff" stopOpacity="0" />
                    <stop offset="100%" stopColor="#000" stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id="rimLight" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#000" stopOpacity="0" />
                    <stop offset="85%" stopColor="#000" stopOpacity="0" />
                    <stop offset="94%" stopColor="#fff" stopOpacity="0.08" />
                    <stop offset="100%" stopColor="#fff" stopOpacity="0.12" />
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
                      <path d={path} fill="url(#segDepth)" />
                      <path d={path} fill="url(#segShimmer)" />
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

                <circle cx="150" cy="150" r="148" fill="url(#rimLight)" />
                <circle cx="150" cy="150" r="148" fill="url(#innerGlow)" />

                {/* TEXT LABELS — radial text along each segment's center line */}
                {WHEEL_SEGMENTS.map((seg, i) => {
                  const midAngle = i * SEG_ANGLE - 90 + SEG_ANGLE / 2;
                  const displayLabel = seg.isLoss ? 'TRY AGAIN' : seg.label;
                  return (
                    <g key={`t${i}`} transform={`rotate(${midAngle}, 150, 150)`}>
                      <text
                        x={150 + 90}
                        y={150}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="white"
                        fontSize={seg.isLoss ? "12" : "22"}
                        fontWeight="900"
                        fontFamily="Arial Black, Arial, sans-serif"
                        stroke="rgba(0,0,0,0.6)"
                        strokeWidth="3"
                        paintOrder="stroke"
                        letterSpacing={seg.isLoss ? "1" : "3"}
                      >
                        {displayLabel}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* === CENTER HUB with STOP button === */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20" style={{ width: '22%', height: '22%' }}>
              <svg viewBox="0 0 90 90" className="w-full h-full">
                <defs>
                  <radialGradient id="hubSphere" cx="38%" cy="30%" r="65%">
                    <stop offset="0%" stopColor="#777" />
                    <stop offset="15%" stopColor="#555" />
                    <stop offset="40%" stopColor="#2a2a2a" />
                    <stop offset="70%" stopColor="#111" />
                    <stop offset="100%" stopColor="#000" />
                  </radialGradient>
                  <linearGradient id="hubChrome" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#ddd" />
                    <stop offset="20%" stopColor="#fff" />
                    <stop offset="45%" stopColor="#777" />
                    <stop offset="70%" stopColor="#e0e0e0" />
                    <stop offset="100%" stopColor="#aaa" />
                  </linearGradient>
                  <radialGradient id="hubSpec" cx="35%" cy="25%">
                    <stop offset="0%" stopColor="#fff" stopOpacity="0.5" />
                    <stop offset="40%" stopColor="#fff" stopOpacity="0.08" />
                    <stop offset="100%" stopColor="#fff" stopOpacity="0" />
                  </radialGradient>
                </defs>
                <circle cx="45" cy="45" r="44" fill="none" stroke="url(#hubChrome)" strokeWidth="5" />
                <circle cx="45" cy="45" r="39" fill="url(#hubSphere)" />
                <ellipse cx="38" cy="34" rx="16" ry="12" fill="url(#hubSpec)" />
              </svg>
              <button
                type="button"
                onClick={phase === 'spinning' ? stopWheel : undefined}
                disabled={phase !== 'spinning'}
                className={`absolute inset-0 rounded-full flex items-center justify-center transition-all duration-200 ${
                  phase === 'spinning' ? 'hover:scale-110 active:scale-90 cursor-pointer' : 'cursor-default'
                }`}
              >
                <span className={`font-black text-base sm:text-lg tracking-wider transition-opacity duration-300 ${phase !== 'spinning' ? 'opacity-40' : ''}`} style={{
                  background: 'linear-gradient(180deg, #ff9999 0%, #ef4444 40%, #b91c1c 100%)',
                  WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                  filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.9))',
                }}>STOP</span>
              </button>
            </div>
          </div>

          {/* ============ BOTTOM ROW ============ */}
          <div className="flex items-center justify-between mt-2">
            <div className="flex-1 min-w-0">
              {phase === 'spinning' && (
                <div className="flex items-center justify-center gap-2 text-gray-400 py-1">
                  <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
                  <span className="font-bold text-sm tracking-wide">Tap STOP to win!</span>
                  <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
                </div>
              )}
              {phase === 'stopping' && (
                <div className="flex items-center justify-center gap-2 text-gray-400 py-1">
                  <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
                  <span className="font-bold text-sm tracking-wide">Slowing down...</span>
                  <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />
                </div>
              )}
              {phase === 'done' && spinsLeft <= 0 && !result && (
                <div className="flex items-center gap-3">
                  <p className="text-gray-500 text-xs">No spins left!</p>
                  <button type="button" onClick={() => { setSpinsLeft(1); }}
                    className="px-4 py-1.5 bg-gradient-to-r from-cyan-500 to-blue-600 rounded-lg font-bold text-xs hover:scale-105 active:scale-95 transition-all">
                    Reset (Demo)
                  </button>
                </div>
              )}
            </div>

            {/* Spins counter */}
            <div className="flex-shrink-0 ml-3">
              <div className="px-5 py-2.5 rounded-lg font-bold text-sm sm:text-base" style={{ background: '#111', border: '1px solid #333' }}>
                Spins: {spinsLeft}
              </div>
            </div>
          </div>

          {/* History */}
          {history.length > 0 && (
            <div className="mt-2">
              <button type="button" onClick={() => setShowHistory(!showHistory)}
                className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-xs" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <span className="flex items-center gap-1.5 text-gray-400">
                  <Trophy className="w-3 h-3 text-amber-400" /> History ({history.length})
                </span>
                <span className="text-gray-600">{showHistory ? '▲' : '▼'}</span>
              </button>
              {showHistory && (
                <div className="mt-1.5 space-y-1 max-h-24 overflow-y-auto" style={{ animation: 'scaleIn 0.2s ease-out' }}>
                  {history.map((h, i) => (
                    <div key={i} className="flex items-center justify-between px-3 py-1.5 rounded text-[10px]" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
                      <span className="flex items-center gap-1.5">
                        <span>{h.icon}</span>
                        <span className="font-semibold text-gray-300">{h.isLoss ? 'Try Again Tomorrow' : `K${h.prize.kwacha}`}</span>
                      </span>
                      <span className="text-gray-600">{h.time}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
