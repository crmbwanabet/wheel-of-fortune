// Operator killswitch: stop ALL payouts within one spin, no redeploy.
//
// On 2026-08-14 a mid-day payout-mode change paid out K1,710 in ten minutes,
// and the only way to stop it was hand-written SQL against wheel_daily_state
// (drain the queue, blank the winning-position map, empty the carryover). That
// worked, but it was destructive — it wiped the day's prize map — and it could
// not be reversed. This is the same capability as a flag: reversible, leaves no
// wreckage, and takes effect on the very next spin.
//
// What it deliberately is NOT: SPIN_MAINTENANCE, which takes the whole wheel
// down. Customers keep playing here. They land on "Try Again Tomorrow" via the
// ordinary loss path that already runs in production, so nothing new can break
// in the widget.
//
// Pure decisions only — the caller does the I/O.

// Is the payout killswitch engaged?
//
// row:   the wheel_controls row, or null/undefined if absent
// error: whatever the read returned, if it failed
//
// FAILS OPEN. A killswitch that engages itself on a DB hiccup would stop every
// payout with no operator action, and the symptom ("nobody is winning") is
// indistinguishable from normal bad luck — it could run for a full day unnoticed.
// A read failure must leave the wheel exactly as it was.
//
// Only a real boolean `true` engages it: a NULL column, a string, or a 1 all
// mean "somebody wrote something we did not intend", and guessing in the
// direction of stopping payouts is the more expensive guess to get wrong.
export function resolveWinsDisabled(row, error) {
  if (error) return false;
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  return row.wins_disabled === true;
}

// Should this spin run the deposit-eligibility check?
//
// While the switch is engaged there is nothing for the gate to decide — every
// spin is a loss regardless — and each check is a paid round-trip to BwanaBet
// on the hot path. Skipping it means engaging the switch also sheds load and
// external dependency at the exact moment something is going wrong.
//
// It also keeps the telemetry honest: gate rows are only written when the gate
// actually ran, so killswitch losses are never miscounted as
// "a win the deposit gate blocked".
export function shouldRunDepositGate({ isTest, winsDisabled, mode }) {
  if (isTest) return false;
  if (winsDisabled) return false;
  return mode === 'shadow' || mode === 'enforce';
}
