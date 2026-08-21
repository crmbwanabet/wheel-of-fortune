import { getSupabase } from './supabase';
import { reportError } from './telemetry.js';

/**
 * Supabase-backed rate limiter. Survives Vercel serverless cold starts
 * and is consistent across instances.
 *
 * @param {string} scope  - logical bucket name, e.g. 'spin' or 'validate'
 * @param {string} ip     - client IP
 * @param {number} [limit=5]     - max requests per window
 * @param {number} [windowSec=60] - window size in seconds
 * @returns {Promise<boolean>} true if under limit, false if rate-limited
 */
export async function checkRateLimit(scope, ip, limit = 5, windowSec = 60) {
  if (!ip || ip === 'unknown') return true; // Can't enforce without an IP
  try {
    const { data, error } = await getSupabase().rpc('check_rate_limit', {
      p_scope: scope,
      p_ip: ip,
      p_limit: limit,
      p_window_sec: windowSec,
    });
    if (error) {
      // Fail open — but a limiter that cannot reach the DB is an incident
      // signal. Not awaited: hot path, and reportError never throws.
      reportError(error, { route: scope, status: 200, code: 'ratelimit_rpc_failed' });
      return true;
    }
    return data === true;
  } catch (err) {
    reportError(err, { route: scope, status: 200, code: 'ratelimit_rpc_failed' });
    return true;
  }
}
