'use client';

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { createWheelTexture } from './WheelSegmentTexture';

const SEG_ANGLE = (2 * Math.PI);

export default function WheelMesh({ segments, spinAngleRef }) {
  const wheelGroupRef = useRef();
  const wheelTexture = useMemo(() => createWheelTexture(segments), [segments]);

  // Sync rotation from spinAngleRef every frame
  useFrame(() => {
    if (wheelGroupRef.current && spinAngleRef.current !== undefined) {
      // spinAngleRef is in degrees (clockwise), Three.js Y rotation is radians (CCW)
      // Negate to match CSS clockwise rotation
      wheelGroupRef.current.rotation.y = -(spinAngleRef.current * Math.PI) / 180;
    }
  });

  const numSegs = segments.length;
  const wheelRadius = 2;
  const wheelThickness = 0.28;
  const rimThickness = 0.12;

  // Gold peg positions
  const pegs = useMemo(() => {
    return segments.map((_, i) => {
      const angle = (i * 2 * Math.PI) / numSegs;
      return {
        x: wheelRadius * 0.92 * Math.cos(angle),
        z: wheelRadius * 0.92 * Math.sin(angle),
      };
    });
  }, [segments, numSegs]);

  return (
    <group>
      {/* ============ ROTATING WHEEL GROUP ============ */}
      <group ref={wheelGroupRef}>
        {/* Main wheel disc */}
        <mesh position={[0, 0, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[wheelRadius, wheelRadius, wheelThickness, 64]} />
          {/* Side = chrome rim, Top = segments texture, Bottom = dark */}
          <meshStandardMaterial attach="material-0" color="#666" metalness={0.85} roughness={0.18} />
          <meshStandardMaterial attach="material-1" map={wheelTexture} />
          <meshStandardMaterial attach="material-2" color="#0a0a0f" metalness={0.3} roughness={0.8} />
        </mesh>

        {/* Gold pegs at segment dividers */}
        {pegs.map((peg, i) => (
          <mesh key={`peg-${i}`} position={[peg.x, wheelThickness / 2 + 0.04, peg.z]} castShadow>
            <cylinderGeometry args={[0.055, 0.065, 0.1, 12]} />
            <meshStandardMaterial color="#ffd700" metalness={0.8} roughness={0.2} emissive="#b8860b" emissiveIntensity={0.15} />
          </mesh>
        ))}
      </group>

      {/* ============ STATIC ELEMENTS (don't rotate) ============ */}

      {/* Outer chrome ring / frame */}
      <mesh position={[0, wheelThickness * 0.3, 0]}>
        <torusGeometry args={[wheelRadius + 0.08, rimThickness, 16, 64]} />
        <meshStandardMaterial color="#c0c0c0" metalness={0.92} roughness={0.1} envMapIntensity={1.5} />
      </mesh>

      {/* Inner chrome ring */}
      <mesh position={[0, wheelThickness * 0.3, 0]}>
        <torusGeometry args={[wheelRadius - 0.02, rimThickness * 0.5, 12, 64]} />
        <meshStandardMaterial color="#aaa" metalness={0.9} roughness={0.12} />
      </mesh>

      {/* Chasing light bulbs on the rim */}
      {Array.from({ length: 24 }, (_, i) => {
        const angle = (i * 2 * Math.PI) / 24;
        const lR = wheelRadius + 0.08;
        return (
          <mesh key={`light-${i}`} position={[lR * Math.cos(angle), wheelThickness * 0.3 + rimThickness * 0.8, lR * Math.sin(angle)]}>
            <sphereGeometry args={[0.04, 8, 8]} />
            <meshStandardMaterial
              color={['#fbbf24', '#ffffff', '#ec4899', '#ffffff', '#a855f7', '#ffffff'][i % 6]}
              emissive={['#fbbf24', '#ffffff', '#ec4899', '#ffffff', '#a855f7', '#ffffff'][i % 6]}
              emissiveIntensity={0.6}
            />
          </mesh>
        );
      })}

      {/* Center hub */}
      <mesh position={[0, wheelThickness / 2 + 0.01, 0]}>
        <cylinderGeometry args={[0.42, 0.42, 0.12, 32]} />
        <meshStandardMaterial color="#1a1a1a" metalness={0.7} roughness={0.25} />
      </mesh>
      {/* Hub chrome ring */}
      <mesh position={[0, wheelThickness / 2 + 0.07, 0]}>
        <torusGeometry args={[0.42, 0.035, 12, 32]} />
        <meshStandardMaterial color="#ccc" metalness={0.9} roughness={0.1} />
      </mesh>
      {/* Hub highlight sphere */}
      <mesh position={[0, wheelThickness / 2 + 0.08, 0]}>
        <sphereGeometry args={[0.15, 16, 16]} />
        <meshStandardMaterial color="#222" metalness={0.6} roughness={0.3} />
      </mesh>
    </group>
  );
}
