import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSupabase } from '@/lib/supabase';
import { reportError, sendOwnerAlert } from '@/lib/telemetry';
import { evaluateGateHealth, decideAlerts, formatGateAlert } from '@/lib/gateHealth';

export const dynamic = 'force-dynamic';

// Parse an env number, honoring a legitimate 0 (e.g. COOLDOWN_MIN=0 = alert every
// run while a condition keeps firing). Only a missing/non-numeric value falls back.
const envNum = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
};

const WINDOW_MIN = envNum('GATE_MONITOR_WINDOW_MIN', 15);
const COOLDOWN_MIN = envNum('GATE_MONITOR_COOLDOWN_MIN', 30);
const THRESHOLDS = {
  minSample: envNum('GATE_MONITOR_MIN_SAMPLE', 10),
  failRateShadow: envNum('GATE_MONITOR_FAIL_RATE_SHADOW', 0.30),
  failRateEnforce: envNum('GATE_MONITOR_FAIL_RATE_ENFORCE', 0.20),
  p95Ms: envNum('GATE_MONITOR_P95_MS', 1500),
  falseDenials: envNum('GATE_MONITOR_FALSE_DENIALS', 3),
};

export async function GET(request) { return handle(request); }
export async function POST(request) { return handle(request); }

async function handle(request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization') || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const supabase = getSupabase();
    const now = Date.now();
    const sinceIso = new Date(now - WINDOW_MIN * 60 * 1000).toISOString();

    const { data: rows, error: qErr } = await supabase
      .from('wheel_deposit_checks')
      .select('mode,decision,reason,eventual_eligible,eventual_latency_ms')
      .gte('created_at', sinceIso);
    if (qErr) throw qErr;

    const ev = evaluateGateHealth(rows || [], THRESHOLDS);

    const { data: stateRows } = await supabase
      .from('wheel_monitor_state')
      .select('condition,firing,last_alert_at');
    const priorState = {};
    for (const s of stateRows || []) {
      priorState[s.condition] = {
        firing: s.firing,
        lastAlertAt: s.last_alert_at ? Date.parse(s.last_alert_at) : null,
      };
    }

    const decisions = decideAlerts(ev.conditions, priorState, now, COOLDOWN_MIN * 60 * 1000);
    for (const d of decisions) {
      await sendOwnerAlert(formatGateAlert(d, ev));
    }

    // Persist current state for every condition (fired ones get a fresh timestamp).
    const fired = new Set(decisions.filter((d) => d.action === 'fire').map((d) => d.condition));
    const nowIso = new Date(now).toISOString();
    const upserts = Object.entries(ev.conditions).map(([name, cond]) => ({
      condition: name,
      firing: cond.firing,
      last_alert_at: fired.has(name)
        ? nowIso
        : (priorState[name]?.lastAlertAt ? new Date(priorState[name].lastAlertAt).toISOString() : null),
      last_value: cond.value,
      updated_at: nowIso,
    }));
    await supabase.from('wheel_monitor_state').upsert(upserts, { onConflict: 'condition' });

    return NextResponse.json({
      ok: true,
      n: ev.n,
      alerts: decisions.map((d) => ({ condition: d.condition, action: d.action })),
    });
  } catch (err) {
    // A broken monitor must itself be visible.
    waitUntil(reportError(err, { route: 'gate-monitor', status: 500, code: 'monitor_query_failed' }));
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
