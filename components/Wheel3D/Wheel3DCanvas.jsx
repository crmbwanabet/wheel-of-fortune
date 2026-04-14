'use client';

import { useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import WheelMesh from './WheelMesh';

function CameraSetup() {
  const { camera } = useThree();
  useEffect(() => {
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera]);
  return null;
}

export default function Wheel3DCanvas({ segments, spinAngleRef, phase, onStop }) {
  return (
    <Canvas
      camera={{ position: [0, 4.5, 3.2], fov: 36, near: 0.1, far: 50 }}
      style={{ background: 'transparent' }}
      gl={{ alpha: true, antialias: true }}
    >
      <CameraSetup />

      {/* Lighting */}
      <ambientLight intensity={0.6} />
      <directionalLight position={[0, 10, 3]} intensity={1.5} />
      <pointLight position={[0, 2, -4]} intensity={0.4} color="#8b9dc3" />
      <pointLight position={[3, 3, 1]} intensity={0.3} color="#fbbf24" />

      {/* The 3D wheel */}
      <WheelMesh segments={segments} spinAngleRef={spinAngleRef} />

      {/* STOP button as HTML overlay at wheel center */}
      <Html center position={[0, 0.25, 0]} style={{ pointerEvents: 'auto' }}>
        <button
          type="button"
          onClick={phase === 'spinning' ? onStop : undefined}
          disabled={phase !== 'spinning'}
          style={{
            width: 64,
            height: 64,
            borderRadius: '50%',
            border: '3px solid #555',
            background: 'radial-gradient(circle at 38% 30%, #555, #1a1a1a 60%, #000)',
            cursor: phase === 'spinning' ? 'pointer' : 'default',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 4px 15px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.1)',
            transition: 'transform 0.15s',
          }}
          onMouseDown={(e) => { if (phase === 'spinning') e.currentTarget.style.transform = 'scale(0.9)'; }}
          onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
        >
          <span style={{
            fontFamily: 'Arial Black, Arial, sans-serif',
            fontWeight: 900,
            fontSize: 16,
            letterSpacing: '2px',
            background: 'linear-gradient(180deg, #ff9999, #ef4444 40%, #b91c1c)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            opacity: phase !== 'spinning' ? 0.4 : 1,
            transition: 'opacity 0.3s',
          }}>STOP</span>
        </button>
      </Html>
    </Canvas>
  );
}
