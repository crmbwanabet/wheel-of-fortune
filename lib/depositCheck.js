import { previousWheelDayWindowUtc } from './wheelTime.js';
import { hasQualifyingDeposit } from './depositEligibility.js';

// The BwanaBet history API returns `{error:true, errCode:28, message:"history
// result error"}` (HTTP 200) when the account has NO transactions in the
// requested window. That is a legitimate empty result — a real "no deposit" —
// NOT an API failure, so it must map to no_deposit, not error.
const EMPTY_HISTORY_ERRCODE = 28;

// Live deposit-eligibility check. Resolves to:
//   { sync, completion }
// - sync: the verdict that drives the spin, settled within timeoutMs
//     { eligible, reason, latencyMs }  reason ∈ deposit_found|no_deposit|timeout|error
//   Fail-closed: timeout / error ⇒ eligible=false.
// - completion: a Promise for the eventual ground-truth once the call finishes
//     { eligible, reason, latencyMs, httpStatus, error }
//   The fetch is NOT aborted on the sync timeout — it keeps running (hard-capped
//   by bgCapMs) so we can record whether a timed-out user was actually eligible.
export async function checkDepositEligibility({
  token,
  nowMs = Date.now(),
  timeoutMs = 2000,
  bgCapMs = 10000,
  apiBase = process.env.BWANA_API_BASE || 'https://api.bwanabet.co.zm',
  fetchImpl = fetch,
  clock = () => Date.now(),
}) {
  const win = previousWheelDayWindowUtc(nowMs);
  const t0 = clock();

  const completion = (async () => {
    const controller = new AbortController();
    const cap = setTimeout(() => controller.abort(), bgCapMs);
    if (typeof cap.unref === 'function') cap.unref();
    try {
      const res = await fetchImpl(`${apiBase}/api/v2/transactions/history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token },
        body: JSON.stringify({ days: '3' }),
        signal: controller.signal,
      });
      const latencyMs = clock() - t0;
      if (!res.ok) {
        return { eligible: false, reason: 'error', latencyMs, httpStatus: res.status, error: `http_${res.status}` };
      }
      const json = await res.json().catch(() => null);
      if (!json) {
        return { eligible: false, reason: 'error', latencyMs, httpStatus: res.status, error: 'bad_json' };
      }
      if (json.error) {
        // Empty-history error = the customer simply has no transactions in the
        // window → not eligible, but NOT an error condition.
        if (json.errCode === EMPTY_HISTORY_ERRCODE) {
          return { eligible: false, reason: 'no_deposit', latencyMs, httpStatus: res.status, error: null };
        }
        return { eligible: false, reason: 'error', latencyMs, httpStatus: res.status, error: `api_error_${json.errCode ?? 'unknown'}` };
      }
      const eligible = hasQualifyingDeposit(json.data, win);
      return {
        eligible,
        reason: eligible ? 'deposit_found' : 'no_deposit',
        latencyMs,
        httpStatus: res.status,
        error: null,
      };
    } catch (err) {
      return {
        eligible: false,
        reason: 'error',
        latencyMs: clock() - t0,
        httpStatus: null,
        error: String((err && err.message) || err).slice(0, 200),
      };
    } finally {
      clearTimeout(cap);
    }
  })();

  let timeoutHandle;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve({ eligible: false, reason: 'timeout', latencyMs: clock() - t0 }),
      timeoutMs,
    );
    if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
  });

  const sync = await Promise.race([completion, timeout]);
  // If completion won the race, the timeout timer is now a no-op — clear it so
  // it doesn't linger on the fast path.
  clearTimeout(timeoutHandle);
  return { sync, completion };
}
