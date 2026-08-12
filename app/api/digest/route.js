import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { getWheelDayDate, WINNABLE_POSITIONS } from '@/lib/algorithms';
import { cooldownDigestLines } from '@/lib/cooldownDigest';
import { shiftWheelDay } from '@/lib/cooldown';

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
  // Report the last COMPLETE wheel-day, never the one in progress.
  //
  // The cron fires at 04:10 UTC, ten minutes after the 04:00 UTC (06:00 CAT)
  // reset, so getWheelDayDate() returns the day that has barely started. That
  // is not a rounding error: spins spike to ~50/min in the minutes after the
  // reset (vs ~8/min before it), so the digest was reporting several hundred
  // spins of the NEW day as if they were the daily total, and cooldown counts
  // — which accumulate across a full day — would always have read ~0.
  //
  // Shifting back one day is also correct for a manual mid-day run: a daily
  // digest summarises a finished day, not a partial one.
  const day = shiftWheelDay(getWheelDayDate(), -1);

  let text;
  try {
    const supabase = getSupabase();
    const { data: state } = await supabase
      .from('wheel_daily_state')
      .select('total_wins,total_budget_spent,carryover_in')
      .eq('day_date', day).eq('test_bucket', '').maybeSingle();
    // Spin count = one row per spin. wheel_daily_state.total_spins is NOT
    // maintained (would be a hot-row contention point); the row count / per-day
    // sequence is the source of truth.
    const { count: spinCount } = await supabase
      .from('wheel_spin_log')
      .select('id', { count: 'exact', head: true })
      .eq('day_date', day).eq('test_bucket', '');
    const { count: cooldownBlocked } = await supabase
      .from('wheel_spin_log')
      .select('id', { count: 'exact', head: true })
      .eq('day_date', day).eq('test_bucket', '').eq('cooldown_blocked', true);
    const { count: carryoverAwarded } = await supabase
      .from('wheel_spin_log')
      .select('id', { count: 'exact', head: true })
      .eq('day_date', day).eq('test_bucket', '').eq('carryover_awarded', true);

    const spins = spinCount ?? 0;
    if (spins === 0) {
      text = `📊 Wheel daily digest — ${day}\nQuiet day: 0 spins.`;
    } else {
      const queueMode = process.env.WHEEL_PAYOUT_MODE === 'queue';
      let spinsLine;
      let exhaustLine = null;
      if (queueMode) {
        spinsLine = `Spins: ${spins}`;
        // Pot exhausted = the 100th win. Its timestamp tells us when the day's
        // K2,000 ran out (spec: expected ~06:45 CAT at current traffic).
        if ((state?.total_wins ?? 0) >= 100) {
          const { data: hundredth } = await supabase
            .from('wheel_spin_log')
            .select('created_at')
            .eq('day_date', day).eq('test_bucket', '').eq('won', true)
            .order('created_at', { ascending: true })
            .range(99, 99);
          if (hundredth?.[0]?.created_at) {
            const catMs = Date.parse(hundredth[0].created_at) + 2 * 60 * 60 * 1000;
            exhaustLine = `Pot exhausted at ${new Date(catMs).toISOString().slice(11, 16)} CAT`;
          }
        }
      } else {
        const beyond = Math.max(0, spins - WINNABLE_POSITIONS);
        spinsLine = beyond > 0
          ? `Spins: ${spins} (first ${WINNABLE_POSITIONS} winnable, ${beyond} past cap)`
          : `Spins: ${spins} / ${WINNABLE_POSITIONS} winnable`;
      }
      const lines = [
        `📊 Wheel daily digest — ${day}`,
        spinsLine,
        `Wins: ${state?.total_wins ?? 0} → K${state?.total_budget_spent ?? 0} / K2,000 budget`,
      ];
      if (exhaustLine) lines.push(exhaustLine);
      lines.push(...cooldownDigestLines(cooldownBlocked, carryoverAwarded, state?.carryover_in));
      lines.push(`(errors delivered live; see alerts)`);
      text = lines.join('\n');
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
