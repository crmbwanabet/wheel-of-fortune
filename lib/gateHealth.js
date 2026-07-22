// Pure evaluation of deposit-gate health from wheel_deposit_checks rows.
// No DB, no time, no I/O — fully unit-testable.

const isFailure = (r) => r.reason === 'error' || r.reason === 'timeout';

// Nearest-rank percentile (matches Postgres percentile_disc): index = ceil(p*N)-1.
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

const pct = (x) => `${Math.round(x * 100)}%`;

// rows: [{ mode, decision, reason, eventual_eligible, eventual_latency_ms }]
// thresholds: { minSample, failRateShadow, failRateEnforce, p95Ms, falseDenials }
export function evaluateGateHealth(rows, thresholds) {
  const n = rows.length;
  const failures = rows.filter(isFailure).length;
  const failureRate = n > 0 ? failures / n : 0;

  const latencies = rows
    .map((r) => r.eventual_latency_ms)
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  const p95LatencyMs = percentile(latencies, 0.95);

  const falseDenials = rows.filter(
    (r) => r.decision === 'forced_loss' && r.eventual_eligible === true,
  ).length;

  const enforceRows = rows.filter((r) => r.mode === 'enforce');
  const enforceN = enforceRows.length;
  const enforceFailures = enforceRows.filter(isFailure).length;
  const enforceFailureRate = enforceN > 0 ? enforceFailures / enforceN : 0;
  const hasEnforce = enforceN > 0;

  const apiFailingFiring = hasEnforce
    ? enforceN >= thresholds.minSample && enforceFailureRate >= thresholds.failRateEnforce
    : n >= thresholds.minSample && failureRate >= thresholds.failRateShadow;

  const conditions = {
    api_failing: {
      firing: apiFailingFiring,
      severity: hasEnforce ? 'critical' : 'warning',
      value: hasEnforce
        ? `enforceFailRate=${pct(enforceFailureRate)} n=${enforceN}`
        : `failRate=${pct(failureRate)} n=${n}`,
    },
    latency: {
      firing: n >= thresholds.minSample && p95LatencyMs !== null && p95LatencyMs >= thresholds.p95Ms,
      severity: 'warning',
      value: `p95=${p95LatencyMs == null ? 'n/a' : p95LatencyMs + 'ms'} n=${n}`,
    },
    false_denials: {
      firing: falseDenials >= thresholds.falseDenials,
      severity: 'warning',
      value: `falseDenials=${falseDenials}`,
    },
  };

  return { n, failureRate, p95LatencyMs, falseDenials, hasEnforce, enforceN, enforceFailureRate, conditions };
}
