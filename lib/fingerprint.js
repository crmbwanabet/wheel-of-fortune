export async function generateFingerprint() {
  const signals = [];

  signals.push(`${screen.width}x${screen.height}x${screen.colorDepth}`);
  signals.push(Intl.DateTimeFormat().resolvedOptions().timeZone);
  signals.push(navigator.language);
  signals.push(navigator.platform);

  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 200;
    canvas.height = 50;
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('BwanaBet', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('BwanaBet', 4, 17);
    signals.push(canvas.toDataURL());
  } catch {
    signals.push('no-canvas');
  }

  const raw = signals.join('|');
  const encoder = new TextEncoder();
  const data = encoder.encode(raw);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
