import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { getWheelDayDate } from '@/lib/algorithms';

export const dynamic = 'force-dynamic';

// Posts a daily activity digest to the owner's Telegram DM. Cron-triggered.
// Reads ONLY aggregates (once/day) — never writes.
export async function POST(request) {
  return handleDigest(request);
}
export async function GET(request) {
  return handleDigest(request);
}

async function handleDigest(request) {
  // Auth: Vercel Cron sends the CRON_SECRET as a bearer token.
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization') || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  const day = getWheelDayDate();

  let text;
  try {
    const supabase = getSupabase();
    const { data: state } = await supabase
      .from('wheel_daily_state')
      .select('total_spins,total_wins,total_budget_spent')
      .eq('day_date', day).eq('test_bucket', '').maybeSingle();
    const { count: players } = await supabase
      .from('wheel_spin_log')
      .select('customer_id', { count: 'exact', head: true })
      .eq('day_date', day).eq('test_bucket', '');

    if (!state || state.total_spins === 0) {
      text = `📊 Wheel daily digest — ${day}\nQuiet day: 0 spins.`;
    } else {
      text = [
        `📊 Wheel daily digest — ${day}`,
        `Spins: ${state.total_spins} | Players: ${players ?? '—'}`,
        `Wins: ${state.total_wins} → K${state.total_budget_spent} / K2,000 budget`,
        `(errors delivered live; see alerts)`,
      ].join('\n');
    }
  } catch (err) {
    text = `📊 Wheel daily digest — ${day}\n⚠️ digest read failed: ${(err && err.message) || 'error'}`;
  }

  if (token && chatId) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    } catch (err) {
      console.error('[digest] send failed:', err && err.message);
    }
  }
  return NextResponse.json({ ok: true });
}
