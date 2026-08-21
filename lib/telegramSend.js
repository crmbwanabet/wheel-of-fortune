// The ONE place the wheel talks to Telegram. Both alert channels (owner DM,
// win group) and the digest go through here so delivery is verified in one
// spot. Telegram answers HTTP 200 with {ok:false} for many failures, so
// res.ok alone is not enough — both are checked.
//
// On failure a `telegram_send_failed` row is written straight through the
// error sink, deliberately NOT via reportError(): reportError would try to
// Telegram the failure, which is the thing that just failed. The DB row is
// the fallback channel, and it survives Telegram being dead.
import { getSupabase } from './supabase.js';

async function defaultSink(row) {
  await getSupabase().from('wheel_error_log').insert(row);
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Returns true only when Telegram confirmed delivery. Never throws.
export async function sendTelegram({
  token,
  chatId,
  text,
  parseMode = null,
  disablePreview = true,
  fetchImpl = fetch,
  sink = defaultSink,
  source = null,
}) {
  if (!token || !chatId) {
    console.log('[telegram:no-config]', String(text).split('\n')[0]);
    return false;
  }
  let status = null;
  let description = null;
  try {
    const body = { chat_id: chatId, text, disable_web_page_preview: disablePreview };
    if (parseMode) body.parse_mode = parseMode;
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    status = res.status ?? null;
    const json = await res.json().catch(() => null);
    if (res.ok && json && json.ok === true) return true;
    description = (json && json.description) || `HTTP ${status}`;
  } catch (err) {
    description = (err && err.message) || 'fetch threw';
  }
  try {
    await sink({
      signature: 'telegram:telegram_send_failed',
      route: 'telegram',
      code: 'telegram_send_failed',
      status: Number(status) || null,
      customer_id: null,
      message: truncate(`${description} — lost: ${truncate(text, 120)}`, 500),
      occurrences: 1,
      source,
      host: null,
    });
  } catch (e) {
    console.error('[telegram] fallback persist failed:', e && e.message);
  }
  return false;
}
