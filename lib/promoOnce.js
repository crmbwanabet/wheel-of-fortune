// "One spin per visitor" for the free promo wheel. Device-scoped on purpose:
// there is no login and nothing of value is paid out, so localStorage is the
// right amount of enforcement. Keyed per variant — the path links share one
// origin, and spinning on one site must not consume the other's spin.
// Storage is injected so this is testable.
export const PROMO_STORAGE_KEY = 'bb_promo';

function keyFor(variant) {
  return variant ? `${PROMO_STORAGE_KEY}:${variant}` : PROMO_STORAGE_KEY;
}

// Returns the ISO timestamp of the visitor's spin, or null.
export function readPromoSpun(storage, variant) {
  try {
    const raw = storage && storage.getItem(keyFor(variant));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.spunAt === 'string' && !Number.isNaN(Date.parse(parsed.spunAt))
      ? parsed.spunAt
      : null;
  } catch {
    return null;
  }
}

export function writePromoSpun(storage, nowIso, variant) {
  try {
    if (storage) storage.setItem(keyFor(variant), JSON.stringify({ spunAt: nowIso }));
  } catch { /* quota / private mode — the visitor just gets another spin */ }
}
