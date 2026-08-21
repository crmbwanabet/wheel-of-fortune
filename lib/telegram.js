import { WINNABLE_POSITIONS, POOL_SIZE, DAILY_BUDGET } from './algorithms.js';
import { sendTelegram } from './telegramSend.js';

// Zambia is CAT = UTC+2 (no DST). The server clock/tzdata is unreliable (the
// sandbox mislabels Africa/Lusaka as UTC+0), so we apply the +2h offset
// manually — matching getWheelDay's approach elsewhere — rather than trusting
// local time or toISOString() (which is UTC and reads 2h behind local).
export function catTimestamp(now = Date.now()) {
  return new Date(now + 2 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' CAT';
}

// Build the win-notification text. In positions mode `spinNumber` is the
// winner's slot out of WINNABLE_POSITIONS; in queue mode the win ordinal
// (winsToday of 100) is what matters — spin position is meaningless there.
export function formatWinMessage({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber, payoutMode = 'positions', poolSize = POOL_SIZE }) {
  const spinLine = payoutMode === 'queue'
    ? `🎡 Win #${winsToday} of ${poolSize}`
    : `🎡 Spin: ${spinNumber}/${WINNABLE_POSITIONS}`;
  return [
    '🎉 WHEEL WIN',
    `👤 User ID: ${customerId}`,
    `💰 Prize: K${prizeAmount}`,
    spinLine,
    `🕐 Time: ${catTimestamp()}`,
    `📈 Daily: ${winsToday}/${poolSize} wins | K${budgetSpent}/K${DAILY_BUDGET.toLocaleString('en-US')} budget`,
  ].join('\n');
}

// Returns true only when Telegram confirmed delivery. The caller (spin route)
// reports false as win_notify_failed so a paid-out win always has a record.
export async function sendWinNotification({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber, payoutMode, poolSize }) {
  const message = formatWinMessage({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber, payoutMode, poolSize });
  return sendTelegram({
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    text: message,
    parseMode: 'HTML',
    source: 'win',
  });
}
