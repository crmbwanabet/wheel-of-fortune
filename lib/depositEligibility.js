// Pure predicate: does this transaction-history payload contain a qualifying
// deposit for the given UTC window?
//
// A qualifying deposit is a record whose op_type marks a deposit (`IN-*`,
// e.g. "IN-KZ-AIRTEL"; withdrawals are `OUT-*`), whose status is SUCCESS, and
// whose created_at (UTC) falls in [startMs, endMs] — endMs is the spin moment,
// inclusive, so a deposit made seconds before the spin qualifies.
export function hasQualifyingDeposit(data, { startMs, endMs }) {
  if (!Array.isArray(data)) return false;
  return data.some((r) => {
    if (!r || typeof r.op_type !== 'string') return false;
    if (!r.op_type.startsWith('IN-')) return false;
    if (r.status !== 'SUCCESS') return false;
    const t = Date.parse(r.created_at);
    return Number.isFinite(t) && t >= startMs && t <= endMs;
  });
}
