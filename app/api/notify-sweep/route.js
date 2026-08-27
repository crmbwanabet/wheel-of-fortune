import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSupabase } from '@/lib/supabase';
import { sendTelegram } from '@/lib/telegramSend';
import { reportError } from '@/lib/telemetry';
import {
  MAX_ATTEMPTS, SEND_SPACING_MS, SWEEP_BATCH, STUCK_AFTER_MS, sweepEligible,
} from '@/lib/notifyOutbox';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Re-sends win notifications Telegram rejected on the first try. Wallets are
// credited manually from the group, so every outbox row must end 'sent' — or
// end 'failed' WITH an owner alert, never silently. Cron: every 5 minutes.
async function sweep() {
  const supabase = getSupabase();
  const { data: rows, error } = await supabase
    .from('wheel_win_notifications')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(50);
  if (error) throw error;

  const now = Date.now();
  const due = (rows || []).filter((r) => sweepEligible(r, now)).slice(0, SWEEP_BATCH);
  let sent = 0, failed = 0, abandoned = 0;

  for (const row of due) {
    const delivered = await sendTelegram({
      token: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
      text: row.message,
      parseMode: 'HTML',
      source: 'win-sweep',
    });
    const attempts = (row.attempts || 0) + 1;
    if (delivered) {
      sent++;
      await supabase.from('wheel_win_notifications')
        .update({ status: 'sent', sent_at: new Date().toISOString(), attempts, last_attempt_at: new Date().toISOString() })
        .eq('id', row.id);
    } else if (attempts >= MAX_ATTEMPTS) {
      abandoned++;
      await supabase.from('wheel_win_notifications')
        .update({ status: 'failed', attempts, last_attempt_at: new Date().toISOString() })
        .eq('id', row.id);
      // The one alert that must reach the owner: a paid win whose credit
      // message could not be delivered after ~an hour of retries.
      waitUntil(reportError(
        new Error(`win notification ABANDONED after ${attempts} attempts: customer=${row.customer_id} prize=K${row.prize_kwacha} day=${row.day_date}`),
        { route: 'notify-sweep', status: 500, code: 'win_notify_abandoned' },
      ));
    } else {
      failed++;
      await supabase.from('wheel_win_notifications')
        .update({ attempts, last_attempt_at: new Date().toISOString() })
        .eq('id', row.id);
    }
    await sleep(SEND_SPACING_MS);
  }

  // Pipeline-stuck alarm: something pending for half an hour means retries
  // are not working (bad token, group change) — page the owner.
  const stuckBefore = new Date(now - STUCK_AFTER_MS).toISOString();
  const { count: stuck } = await supabase
    .from('wheel_win_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
    .lt('created_at', stuckBefore);
  if (stuck > 0) {
    waitUntil(reportError(
      new Error(`win-notification outbox stuck: ${stuck} pending > 30min`),
      { route: 'notify-sweep', status: 500, code: 'win_outbox_stuck', minCount: 1 },
    ));
  }

  return { due: due.length, sent, failed, abandoned, stuck: stuck || 0 };
}

async function handle(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  try {
    const result = await sweep();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    waitUntil(reportError(err, { route: 'notify-sweep', status: 500, code: 'sweep_failed' }));
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

export async function GET(request) { return handle(request); }
export async function POST(request) { return handle(request); }
