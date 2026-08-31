// Which game the widget shows on a given wheel-day: the wheel or the mystery
// boxes. Pure and deterministic — every device flips together at the 09:00 CAT
// reset with no server coordination, because the rule needs nothing but the
// wheel-day string both sides already compute.
//
// The GAME is presentation only. Either way the outcome comes from the same
// /api/spin -> claim_spin path: same prizes, pacing, dedupe and telemetry.

// Labels shown flying into the boxes, matching the wheel's slice artwork:
// the six real prizes, the display-only jackpot, and two loss boxes (the
// wheel is half losses; two of nine keeps that flavour without dominating).
export const BOX_LABELS = [
  'K5', 'K10', 'K20', 'K50', 'K100', 'K200', 'K10,000', 'TRY AGAIN', 'TRY AGAIN',
];

export function gameForWheelDay(dayStr) {
  const t = Date.parse(String(dayStr) + 'T00:00:00Z');
  if (!Number.isFinite(t)) return 'wheel';
  const serial = Math.floor(t / 86400000);
  return serial % 2 === 0 ? 'wheel' : 'box';
}

// ?game=wheel|box overrides the rotation (testing, or forcing one game).
export function resolveGame(search, dayStr) {
  try {
    const g = new URLSearchParams(search || '').get('game');
    if (g === 'wheel' || g === 'box') return g;
  } catch { /* fall through to the rotation */ }
  return gameForWheelDay(dayStr);
}

// The 8 labels revealed in the boxes the player did NOT pick: the full label
// set minus one occurrence of the label they won (or one loss box if the
// result label is not in the set), shuffled. Cosmetic — the outcome is the
// server's; this only makes the reveal read like a fair draw.
export function boxDecoys(resultLabel, rnd = Math.random, labels = BOX_LABELS) {
  const rest = labels.slice();
  let i = rest.indexOf(resultLabel);
  if (i < 0) i = rest.indexOf('TRY AGAIN');
  if (i >= 0) rest.splice(i, 1);
  for (let j = rest.length - 1; j > 0; j--) {
    const k = Math.min(j, Math.floor(rnd() * (j + 1)));
    const tmp = rest[j]; rest[j] = rest[k]; rest[k] = tmp;
  }
  return rest;
}
