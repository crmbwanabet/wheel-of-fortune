// What the widget may claim after a spin request failed.
//
// When /api/spin never answers, the wheel is already braking and needs somewhere
// to land. The old code picked a RANDOM LOSS segment. That is not a neutral
// placeholder: the server may have committed the spin before the response was
// lost, and if it committed a WIN the customer was shown a loss and had no way
// to find out. Between 2026-08-11 and 08-14, two of nine spin_network_error
// reports had a spin recorded within ~3 seconds of the error.
//
// So the widget asks /api/spin-status what actually happened, and this function
// decides what that answer entitles it to say. The rule throughout: never assert
// an outcome the server did not confirm. When the evidence runs out, say so —
// an honest "we could not confirm" beats a confident lie.
//
// Pure: no DB, no fetch, no time. The caller does the I/O.

// status: parsed /api/spin-status body, or null/anything if the request failed.
// segmentCount: number of wheel segments, so a bogus index can never be landed on.
//
// Returns one of:
//   { kind: 'recovered', segmentIndex, won, prizeAmount }  the true result
//   { kind: 'not_spun' }        definitely not recorded — the spin is still theirs
//   { kind: 'spent_unknown' }   recorded, but we cannot say which segment
//   { kind: 'unknown' }         we learned nothing
export function classifySpinRecovery(status, segmentCount) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return { kind: 'unknown' };

  // spin-status deliberately FAILS OPEN — a DB error or an unhandled throw
  // returns available:true so a hiccup cannot suppress the wheel for the day.
  // That safety property makes its answer useless to us here, because we cannot
  // tell a genuine "no spin recorded" from "we could not check". Claiming
  // not_spun would invite a retry that /api/spin then rejects as already_spun,
  // putting us straight back on a fabricated loss.
  if (status.reason === 'check_failed') return { kind: 'unknown' };

  // Maintenance short-circuits before the DB is touched, and an auth failure
  // never got as far as looking. Neither says anything about the spin.
  if (status.maintenance === true || status.reason === 'maintenance') return { kind: 'unknown' };
  if (status.error) return { kind: 'unknown' };

  if (status.available === true) return { kind: 'not_spun' };
  if (status.available !== false) return { kind: 'unknown' };

  // A spin is on record. Whether we can SHOW it depends on the payload — an
  // older deployment answers without one.
  const result = status.result;
  if (!result || typeof result !== 'object') return { kind: 'spent_unknown' };

  // Validated against the real wheel rather than trusted: landing on an index
  // outside the wheel would throw in the animation loop, and the customer would
  // lose the result screen entirely on top of losing the spin.
  const idx = result.segmentIndex;
  const usable = Number.isInteger(idx)
    && Number.isInteger(segmentCount)
    && idx >= 0
    && idx < segmentCount;
  if (!usable) return { kind: 'spent_unknown' };

  const prize = Number(result.prizeAmount);
  return {
    kind: 'recovered',
    segmentIndex: idx,
    // The server's verdict, coerced but never re-derived from the segment —
    // the wheel's own segment table is a rendering detail, not the payout record.
    won: Boolean(result.won),
    prizeAmount: Number.isFinite(prize) ? prize : 0,
  };
}
