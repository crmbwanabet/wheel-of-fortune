// Decides what the widget does with a /api/spin-status response.
//
// `available` drives whether the host page shows the trigger button.
// `sticky`    says whether the verdict may be persisted to the per-account
//             localStorage cache.
//
// ONLY a genuine "you already spun today" is sticky. Maintenance mode, auth
// failures and server errors are transient: persisting them would suppress the
// wheel for the rest of the wheel-day and prevent later page loads from even
// retrying. Anything unreadable fails OPEN — /api/spin claims the daily spin
// atomically, so showing the wheel to someone who already spun is safe (they
// get `already_spun` back), whereas hiding it from someone who has not is not.

const STICKY_REASONS = new Set(['already_spun']);

export function decideAvailability({ status, body }) {
  if (!body || typeof body !== 'object') {
    return { available: true, sticky: false, reason: 'unreadable' };
  }
  if (body.available !== false) {
    return { available: true, sticky: false, reason: body.reason || 'available' };
  }
  const reason = body.reason || body.error || (status === 401 ? 'unauthenticated' : 'unknown');
  return { available: false, sticky: STICKY_REASONS.has(reason), reason };
}
