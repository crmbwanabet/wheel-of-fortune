import * as THREE from 'three';

/**
 * Creates a Canvas2D texture for the wheel's top face.
 * Draws colored pie segments with text labels in a circle.
 */
export function createWheelTexture(segments, size = 2048) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 8;
  const segAngle = (2 * Math.PI) / segments.length;

  // Draw segments
  segments.forEach((seg, i) => {
    // Offset by -90deg so segment 0 starts at top
    const startAngle = i * segAngle - Math.PI / 2;
    const endAngle = startAngle + segAngle;

    // Colored wedge
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();

    // Subtle gradient overlay for depth
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.08)');
    grad.addColorStop(0.3, 'rgba(255,255,255,0.03)');
    grad.addColorStop(0.7, 'rgba(0,0,0,0.05)');
    grad.addColorStop(1, 'rgba(0,0,0,0.2)');
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  });

  // Divider lines
  segments.forEach((_, i) => {
    const angle = i * segAngle - Math.PI / 2;
    const ex = cx + r * Math.cos(angle);
    const ey = cy + r * Math.sin(angle);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 4;
    ctx.stroke();
    // Highlight line
    ctx.beginPath();
    ctx.moveTo(cx + 1, cy + 1);
    ctx.lineTo(ex + 1, ey + 1);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  // Text labels
  segments.forEach((seg, i) => {
    const midAngle = i * segAngle - Math.PI / 2 + segAngle / 2;
    const textR = r * 0.62; // distance from center for text

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(midAngle);

    // Text style
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 8;
    ctx.lineJoin = 'round';

    if (seg.isLoss) {
      // Two-line: "TRY AGAIN" + "TOMORROW"
      ctx.font = `900 ${size * 0.038}px "Arial Black", Arial, sans-serif`;
      ctx.strokeText('TRY AGAIN', textR, -size * 0.022);
      ctx.fillText('TRY AGAIN', textR, -size * 0.022);
      ctx.font = `900 ${size * 0.035}px "Arial Black", Arial, sans-serif`;
      ctx.strokeText('TOMORROW', textR, size * 0.022);
      ctx.fillText('TOMORROW', textR, size * 0.022);
    } else {
      ctx.font = `900 ${size * 0.065}px "Arial Black", Arial, sans-serif`;
      ctx.letterSpacing = '3px';
      ctx.strokeText(seg.label, textR, 0);
      ctx.fillText(seg.label, textR, 0);
    }

    ctx.restore();
  });

  // Glossy highlight on top half
  const glossGrad = ctx.createLinearGradient(cx, 0, cx, size);
  glossGrad.addColorStop(0, 'rgba(255,255,255,0.1)');
  glossGrad.addColorStop(0.35, 'rgba(255,255,255,0.03)');
  glossGrad.addColorStop(0.5, 'rgba(0,0,0,0)');
  glossGrad.addColorStop(1, 'rgba(0,0,0,0.08)');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = glossGrad;
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
