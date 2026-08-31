import { WINNABLE_POSITIONS, POOL_SIZE, DAILY_BUDGET } from './algorithms.js';
import { sendTelegram } from './telegramSend.js';

// Zambia is CAT = UTC+2 (no DST). The server clock/tzdata is unreliable (the
// sandbox mislabels Africa/Lusaka as UTC+0), so we apply the +2h offset
// manually — matching getWheelDay's approach elsewhere — rather than trusting
// local time or toISOString() (which is UTC and reads 2h behind local).
export function catTimestamp(now = Date.now()) {
  return new Date(now + 2 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' CAT';
}

// Which game the day was running, for the header and the ordinal line. Wallets
// are credited by hand from this message, so it has to say what the player
// actually played — on a box day "WHEEL WIN" sends ops looking for a spin that
// never happened. Anything unrecognised reads as the wheel.
const GAME_LABELS = {
  wheel: { header: '🎉 WHEEL WIN', icon: '🎡' },
  box: { header: '🎁 MYSTERY BOX WIN', icon: '🎁' },
};

// Build the win-notification text. In positions mode `spinNumber` is the
// winner's slot out of WINNABLE_POSITIONS; in queue mode the win ordinal
// (winsToday of 100) is what matters — spin position is meaningless there.
export function formatWinMessage({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber, payoutMode = 'positions', poolSize = POOL_SIZE, game = 'wheel' }) {
  const { header, icon } = GAME_LABELS[game] || GAME_LABELS.wheel;
  const spinLine = payoutMode === 'queue'
    ? `${icon} Win #${winsToday} of ${poolSize}`
    : `${icon} Spin: ${spinNumber}/${WINNABLE_POSITIONS}`;
  return [
    header,
    `👤 User ID: ${customerId}`,
    `💰 Prize: K${prizeAmount}`,
    spinLine,
    `🕐 Time: ${catTimestamp()}`,
    `📈 Daily: ${winsToday}/${poolSize} wins | K${budgetSpent}/K${DAILY_BUDGET.toLocaleString('en-US')} budget`,
  ].join('\n');
}

// Returns true only when Telegram confirmed delivery. The caller (spin route)
// reports false as win_notify_failed so a paid-out win always has a record.
//
// DELIVERY GUARANTEE: wallets are credited manually from the Telegram group,
// so the message is written to the wheel_win_notifications outbox BEFORE the
// first send attempt. If this attempt fails (the top-of-hour win bursts
// routinely exceed Telegram's ~1 msg/sec group limit), /api/notify-sweep
// re-sends it until Telegram confirms. Outbox IO is best-effort here — a DB
// hiccup must never stop the immediate send attempt.
export async function sendWinNotification({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber, payoutMode, poolSize, dayDate, game }) {
  const message = formatWinMessage({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber, payoutMode, poolSize, game });

  let outboxId = null;
  if (dayDate) {
    try {
      const { getSupabase } = await import('./supabase.js');
      const { data } = await getSupabase()
        .from('wheel_win_notifications')
        .insert({ day_date: dayDate, customer_id: String(customerId), prize_kwacha: Number(prizeAmount) || 0, message })
        .select('id')
        .single();
      outboxId = data ? data.id : null;
    } catch { /* duplicate (retried request) or DB hiccup — send regardless */ }
  }

  // Small jitter so a burst of simultaneous winners does not fire at Telegram
  // in the same instant — lifts first-attempt success; the sweep catches the rest.
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 2500)));

  const delivered = await sendTelegram({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    text: message,
    parseMode: 'HTML',
    source: 'win',
  });

  if (outboxId != null) {
    try {
      const { getSupabase } = await import('./supabase.js');
      await getSupabase()
        .from('wheel_win_notifications')
        .update(delivered
          ? { status: 'sent', sent_at: new Date().toISOString(), attempts: 1, last_attempt_at: new Date().toISOString() }
          : { attempts: 1, last_attempt_at: new Date().toISOString() })
        .eq('id', outboxId);
    } catch { /* the sweep treats an unmarked sent row as pending — a rare
                 duplicate message beats a lost one for a manual-credit flow */ }
  }
  return delivered;
}
