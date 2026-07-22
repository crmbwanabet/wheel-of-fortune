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

// Decide which conditions to alert on, given prior persisted state.
// priorState: { [condition]: { firing: boolean, lastAlertAt: number|null } }
// Returns [{ condition, action: 'fire'|'recover', severity }].
export function decideAlerts(conditions, priorState, now, cooldownMs) {
  const out = [];
  for (const [name, cond] of Object.entries(conditions)) {
    const prior = priorState[name] || { firing: false, lastAlertAt: null };
    if (cond.firing) {
      const cooled = prior.lastAlertAt == null || now - prior.lastAlertAt >= cooldownMs;
      if (!prior.firing || cooled) out.push({ condition: name, action: 'fire', severity: cond.severity });
    } else if (prior.firing) {
      out.push({ condition: name, action: 'recover', severity: cond.severity });
    }
  }
  return out;
}

const LABELS = { api_failing: 'API degraded', latency: 'latency high', false_denials: 'false denials' };
const pctf = (x) => `${Math.round(x * 100)}%`;

// Build the Telegram text for one decision, using the evaluation's numbers.
export function formatGateAlert(decision, ev) {
  const label = LABELS[decision.condition] || decision.condition;
  if (decision.action === 'recover') {
    return `✅ Deposit gate: ${label} — recovered (n=${ev.n})`;
  }
  if (decision.condition === 'api_failing') {
    if (decision.severity === 'critical') {
      return [
        '🚨🚨 Deposit gate: ENFORCE + API DOWN',
        `${pctf(ev.enforceFailureRate)} of enforced checks failing (n=${ev.enforceN}) — players are being forced to lose.`,
        'Recommend: set DEPOSIT_GATE_MODE=off until BwanaBet recovers.',
      ].join('\n');
    }
    return `⚠️ Deposit gate: API degraded\n${pctf(ev.failureRate)} of checks errored/timed out (n=${ev.n}) — mode: shadow`;
  }
  if (decision.condition === 'latency') {
    return `⚠️ Deposit gate: latency high\np95 eventual latency ${ev.p95LatencyMs}ms (n=${ev.n}) — nearing the 2s timeout.`;
  }
  if (decision.condition === 'false_denials') {
    return `⚠️ Deposit gate: false denials\n${ev.falseDenials} real depositors ruled forced_loss — fail-closed is denying earned wins.`;
  }
  return `Deposit gate: ${label}`;
}
