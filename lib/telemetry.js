// Self-built telemetry: format + deliver error alerts to the owner's Telegram DM,
// with in-memory dedup/throttle/rate-cap and a proactive health signal.
// Each DISPATCHED alert is also persisted to wheel_error_log (one row per
// Telegram message, so writes are bounded by the same rate cap). Every path is
// wrapped so it cannot throw — persistence failures never affect alerting.
import { getSupabase } from './supabase.js';
import { sendTelegram } from './telegramSend.js';

const ALERT_WINDOW_MS = 5 * 60 * 1000;   // repeats within this collapse into a rollup
const MAX_ALERTS_PER_MIN = 6;            // global cap on messages/minute
const HEALTH_THRESHOLD = 20;             // 5xx within 60s to trigger the health signal
const HEALTH_COOLDOWN_MS = 10 * 60 * 1000;

const _state = {
  sig: new Map(),        // signature -> { count, firstAt, lastAlertAt }
  minuteStart: 0,
  minuteSent: 0,
  recent5xx: [],
  lastHealthAlertAt: 0,
};

export function _resetTelemetry() {
  _state.sig.clear();
  _state.minuteStart = 0;
  _state.minuteSent = 0;
  _state.recent5xx = [];
  _state.lastHealthAlertAt = 0;
  _errorSink = defaultErrorSink;
}

export function errorSignature(context = {}) {
  const route = context.route || 'unknown';
  const kind = context.code || context.status || context.type || 'error';
  return `${route}:${kind}`;
}

function truncate(s, n = 300) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Persistence sink for dispatched alerts — overridable in tests. The default
// writes one row to wheel_error_log; tests inject a capturing fn instead.
async function defaultErrorSink(row) {
  await getSupabase().from('wheel_error_log').insert(row);
}
let _errorSink = defaultErrorSink;
export function _setErrorSink(fn) { _errorSink = fn || defaultErrorSink; }

// Persist one row per dispatched alert. Best-effort: own try/catch, never throws,
// never blocks or alters the alert path. Called only where an alert is actually
// sent, so it inherits the caller's dedup/rate-cap (≤ MAX_ALERTS_PER_MIN writes).
async function persistError(context, message, occurrences) {
  try {
    await _errorSink({
      signature: errorSignature(context),
      route: context.route || null,
      code: context.code != null ? String(context.code) : null,
      status: Number(context.status) || null,
      customer_id: context.customerId != null ? String(context.customerId) : null,
      message: truncate(message, 500),
      occurrences: occurrences || 1,
      source: context.source || null,
      // The page the report fired on. Arrives from a public unauthenticated
      // endpoint, so it is truncated like any other caller-supplied string.
      host: context.host != null ? truncate(String(context.host), 200) : null,
    });
  } catch (e) {
    console.error('[telemetry] persist failed:', e && e.message);
  }
}

// Send a plain-text alert to the owner's Telegram DM. Never throws. Returns
// true only when Telegram confirmed delivery; on failure a
// telegram_send_failed row is written through the error sink (see
// telegramSend.js for why that path bypasses reportError).
export async function sendOwnerAlert(text) {
  return sendTelegram({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_ALERT_CHAT_ID,
    text,
    sink: (row) => _errorSink(row),
  });
}

function underRateCap(now) {
  if (now - _state.minuteStart >= 60000) {
    _state.minuteStart = now;
    _state.minuteSent = 0;
  }
  if (_state.minuteSent >= MAX_ALERTS_PER_MIN) return false;
  _state.minuteSent += 1;
  return true;
}

function formatAlert(sig, message, context) {
  const lines = [`🔴 ${sig}`, truncate(message)];
  if (context.route) lines.push(`route: ${context.route}`);
  if (context.status) lines.push(`status: ${context.status}`);
  if (context.customerId) lines.push(`customer: ${context.customerId}`);
  if (context.source) lines.push(`source: ${context.source}`);
  // Which page this came from. A report from localhost or a preview deploy is
  // someone testing, not a customer losing their spin — and read without this
  // line the two are indistinguishable.
  if (context.host) lines.push(`host: ${truncate(String(context.host), 200)}`);
  return lines.join('\n');
}

// Returns the alert text that was dispatched, or null if suppressed/counted.
export async function reportError(err, context = {}, now = Date.now()) {
  try {
    const sig = errorSignature(context);
    const message = (err && err.message) || context.message || String(err || 'error');
    const status = Number(context.status) || 0;

    // --- Health signal: track 5xx rate ---
    if (status >= 500) {
      _state.recent5xx.push(now);
      _state.recent5xx = _state.recent5xx.filter((t) => now - t < 60000);
      if (
        _state.recent5xx.length >= HEALTH_THRESHOLD &&
        (_state.lastHealthAlertAt === 0 ||
          now - _state.lastHealthAlertAt > HEALTH_COOLDOWN_MS)
      ) {
        _state.lastHealthAlertAt = now;
        if (underRateCap(now)) {
          const text = `⚠️ Elevated errors on ${context.route || 'the wheel'} — ${_state.recent5xx.length} 5xx in the last minute. Possible DB saturation.`;
          await sendOwnerAlert(text);
          await persistError({ route: context.route, status: context.status, code: 'elevated_5xx', source: context.source }, text, _state.recent5xx.length);
          return text;
        }
      }
    }

    // --- Per-signature dedup/throttle ---
    // minCount > 1 marks a SIGNAL: expected in small numbers, meaningful only
    // in volume (bad tokens, rate limiting). Counted silently until the count
    // inside the window reaches minCount, then dispatched once with the count.
    const minCount = Math.max(1, Number(context.minCount) || 1);
    const st = _state.sig.get(sig);
    if (!st) {
      _state.sig.set(sig, { count: 1, firstAt: now, lastAlertAt: now, dispatched: minCount <= 1 });
      if (minCount <= 1 && underRateCap(now)) {
        const text = formatAlert(sig, message, context);
        await sendOwnerAlert(text);
        await persistError(context, message, 1);
        return text;
      }
      return null;
    }

    st.count += 1;
    const windowElapsed = now - st.lastAlertAt >= ALERT_WINDOW_MS;

    if (minCount > 1 && !st.dispatched) {
      // Signal still below threshold in the current window.
      if (windowElapsed) { st.count = 1; st.lastAlertAt = now; return null; }
      if (st.count < minCount) return null;
      st.dispatched = true;
      const total = st.count;
      st.count = 0;
      st.lastAlertAt = now;
      if (underRateCap(now)) {
        const text = `🔴 ${sig} — ${total}× in the last ${Math.round(ALERT_WINDOW_MS / 60000)} min\n${truncate(message)}`;
        await sendOwnerAlert(text);
        await persistError(context, message, total);
        return text;
      }
      return null;
    }

    if (windowElapsed) {
      const total = st.count;
      if (minCount > 1 && total < minCount) {
        // New window for a signal: start counting again from this event.
        st.count = 1; st.lastAlertAt = now; st.dispatched = false;
        return null;
      }
      st.count = 0;
      st.lastAlertAt = now;
      if (underRateCap(now)) {
        const mins = Math.round(ALERT_WINDOW_MS / 60000);
        const text = `🔴 ${sig} — ${total}× in the last ${mins} min\n${truncate(message)}`;
        await sendOwnerAlert(text);
        await persistError(context, message, total);
        return text;
      }
    }
    return null;
  } catch (e) {
    console.error('[telemetry] reportError failed:', e && e.message);
    return null;
  }
}
