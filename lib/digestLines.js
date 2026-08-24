// Pure formatters for the daily digest. No I/O; the route fetches the counts.

// Fixed order so the line reads the same every day. Mirrors the values
// claim_spin writes to wheel_spin_log.loss_reason.
export const LOSS_REASONS = ['cap_reached', 'pot_empty', 'queue_null', 'cooldown', 'ineligible', 'random'];

export function lossesLine(counts = {}) {
  const parts = LOSS_REASONS
    .filter((r) => Number(counts[r]) > 0)
    .map((r) => `${r} ${Number(counts[r])}`);
  return parts.length ? `Losses: ${parts.join(' · ')}` : null;
}

// Share of winners whose result card actually rendered. Below this ratio
// something is swallowing results between the server and the player's eyes.
const WINS_SEEN_WARN_RATIO = 0.75;

export function winsSeenLine(seen, wins) {
  const w = Number(wins) || 0;
  if (w <= 0) return null;
  const s = Number(seen) || 0;
  const base = `Wins seen: ${s} / ${w}`;
  return s / w < WINS_SEEN_WARN_RATIO ? `${base} ⚠️ below ${Math.round(WINS_SEEN_WARN_RATIO * 100)}%` : base;
}

export function potExhausted(totalWins, poolSize) {
  return (Number(totalWins) || 0) >= poolSize;
}

// One funnel line per promo site. Null when the site saw nothing — an
// unlaunched site should not add noise to the digest.
export function promoLine(label, counts = {}) {
  const v = Number(counts.view) || 0;
  const s = Number(counts.spin) || 0;
  const c = Number(counts.claim_click) || 0;
  if (v + s + c === 0) return null;
  return `Promo ${label}: ${v} views · ${s} spins · ${c} claims`;
}
