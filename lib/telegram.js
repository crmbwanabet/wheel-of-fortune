import { WINNABLE_POSITIONS } from './algorithms.js';

// Zambia is CAT = UTC+2 (no DST). The server clock/tzdata is unreliable (the
// sandbox mislabels Africa/Lusaka as UTC+0), so we apply the +2h offset
// manually — matching getWheelDay's approach elsewhere — rather than trusting
// local time or toISOString() (which is UTC and reads 2h behind local).
export function catTimestamp(now = Date.now()) {
  return new Date(now + 2 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' CAT';
}

// Build the win-notification text. `spinNumber` is the winner's position in the
// day (always ≤ WINNABLE_POSITIONS, since wins only occur on winnable slots).
export function formatWinMessage({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber }) {
  return [
    '🎉 WHEEL WIN',
    `👤 User ID: ${customerId}`,
    `💰 Prize: K${prizeAmount}`,
    `🎡 Spin: ${spinNumber}/${WINNABLE_POSITIONS}`,
    `🕐 Time: ${catTimestamp()}`,
    `📈 Daily: ${winsToday}/100 wins | K${budgetSpent}/K2,000 budget`,
  ].join('\n');
}

export async function sendWinNotification({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber }) {
  const message = formatWinMessage({ customerId, prizeAmount, winsToday, budgetSpent, spinNumber });

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (botToken && chatId) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
      });
    } catch (err) {
      console.error('[Telegram] Failed to send notification:', err.message);
    }
  } else {
    console.log('[Telegram stub]', message);
  }
}
