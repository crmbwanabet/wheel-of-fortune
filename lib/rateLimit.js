import { getSupabase } from './supabase';

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
      console.error('[rateLimit] RPC failed, allowing:', error.message);
      return true; // Fail-open on limiter errors
    }
    return data === true;
  } catch (err) {
    console.error('[rateLimit] Unexpected error, allowing:', err.message);
    return true;
  }
}
