export async function sendWinNotification({ customerId, prizeAmount, winsToday, budgetSpent }) {
  const message = [
    '🎉 WHEEL WIN',
    `👤 User ID: ${customerId}`,
    `💰 Prize: K${prizeAmount}`,
    `🕐 Time: ${new Date().toISOString()}`,
    `📈 Daily: ${winsToday}/100 wins | K${budgetSpent}/K2,000 budget`,
  ].join('\n');

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
