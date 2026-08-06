// Input validation for /api/telemetry, which is public and unauthenticated.
//
// Anything arriving there is a reporting hint and must never be treated as an
// authorisation input. It still has to be constrained before it reaches
// wheel_error_log.customer_id, because that column is read back when tracing
// which customers lost a spin — junk in it makes the trace useless, and a
// stringified object or a hostile string is worse than no attribution at all.

// BwanaBet customer ids are numeric. Returns the id as a string, or undefined
// for anything that is not a plain run of 1-20 digits.
export function parseCustomerId(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const s = String(raw);
  return /^\d{1,20}$/.test(s) ? s : undefined;
}
