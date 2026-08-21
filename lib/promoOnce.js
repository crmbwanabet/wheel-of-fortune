// "One spin per visitor" for the free promo wheel. Device-scoped on purpose:
// there is no login and nothing of value is paid out, so localStorage is the
// right amount of enforcement. Storage is injected so this is testable.
export const PROMO_STORAGE_KEY = 'bb_promo';

// Returns the ISO timestamp of the visitor's spin, or null.
export function readPromoSpun(storage) {
  try {
    const raw = storage && storage.getItem(PROMO_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.spunAt === 'string' && !Number.isNaN(Date.parse(parsed.spunAt))
      ? parsed.spunAt
      : null;
  } catch {
    return null;
  }
}

export function writePromoSpun(storage, nowIso) {
  try {
    if (storage) storage.setItem(PROMO_STORAGE_KEY, JSON.stringify({ spunAt: nowIso }));
  } catch { /* quota / private mode — the visitor just gets another spin */ }
}
