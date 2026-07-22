// Self-built telemetry: format + deliver error alerts to the owner's Telegram DM,
// with in-memory dedup/throttle/rate-cap and a proactive health signal.
// NEVER writes to any database. Every path is wrapped so it cannot throw.

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

// Send a plain-text alert to the owner's Telegram DM. Own try/catch; never throws.
export async function sendOwnerAlert(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chatId) {
    console.log('[telemetry:no-config]', text.split('\n')[0]);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error('[telemetry] send failed:', err && err.message);
  }
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
          return text;
        }
      }
    }

    // --- Per-signature dedup/throttle ---
    const st = _state.sig.get(sig);
    if (!st) {
      _state.sig.set(sig, { count: 1, firstAt: now, lastAlertAt: now });
      if (underRateCap(now)) {
        const text = formatAlert(sig, message, context);
        await sendOwnerAlert(text);
        return text;
      }
      return null;
    }

    st.count += 1;
    if (now - st.lastAlertAt >= ALERT_WINDOW_MS) {
      const total = st.count;
      st.count = 0;
      st.lastAlertAt = now;
      if (underRateCap(now)) {
        const mins = Math.round(ALERT_WINDOW_MS / 60000);
        const text = `🔴 ${sig} — ${total}× in the last ${mins} min\n${truncate(message)}`;
        await sendOwnerAlert(text);
        return text;
      }
    }
    return null;
  } catch (e) {
    console.error('[telemetry] reportError failed:', e && e.message);
    return null;
  }
}
