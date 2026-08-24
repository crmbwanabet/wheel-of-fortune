import { NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { getSupabase } from '@/lib/supabase';
import { getWheelDayDate, WINNABLE_POSITIONS, POOL_SIZE, DAILY_BUDGET } from '@/lib/algorithms';
import { cooldownDigestLines } from '@/lib/cooldownDigest';
import { shiftWheelDay } from '@/lib/cooldown';
import { reportError } from '@/lib/telemetry';
import { sendTelegram } from '@/lib/telegramSend';
import { lossesLine, winsSeenLine, potExhausted, LOSS_REASONS, promoLine } from '@/lib/digestLines';
import { PROMO_VARIANTS } from '@/lib/promoConfig';

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
  // The cron fires at 07:10 UTC, ten minutes after the 07:00 UTC (09:00 CAT)
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
  let readFailed = false;
  try {
    const supabase = getSupabase();
    const base = (q) => q.eq('day_date', day).eq('test_bucket', '');
    const countWhere = async (apply) => {
      const { count, error } = await apply(base(supabase.from('wheel_spin_log').select('id', { count: 'exact', head: true })));
      if (error) throw error;
      return count ?? 0;
    };

    const { data: state, error: stateErr } = await base(
      supabase.from('wheel_daily_state').select('total_wins,total_budget_spent,carryover_in'),
    ).maybeSingle();
    if (stateErr) throw stateErr;

    // Spin count = one row per spin. wheel_daily_state.total_spins is NOT
    // maintained (would be a hot-row contention point); the row count / per-day
    // sequence is the source of truth.
    const spins = await countWhere((q) => q);
    if (spins === 0) {
      text = `📊 Wheel daily digest — ${day}\nQuiet day: 0 spins.`;
    } else {
      const cooldownBlocked = await countWhere((q) => q.eq('cooldown_blocked', true));
      const carryoverAwarded = await countWhere((q) => q.eq('carryover_awarded', true));
      const winsSeen = await countWhere((q) => q.eq('won', true).not('result_seen_at', 'is', null));
      const lossCounts = {};
      for (const r of LOSS_REASONS) lossCounts[r] = await countWhere((q) => q.eq('loss_reason', r));

      const queueMode = process.env.WHEEL_PAYOUT_MODE === 'queue';
      const totalWins = state?.total_wins ?? 0;
      let spinsLine;
      let exhaustLine = null;
      if (queueMode) {
        spinsLine = `Spins: ${spins}`;
        // Pot exhausted = the POOL_SIZE-th win; its timestamp says when the
        // day's budget ran out.
        if (potExhausted(totalWins, POOL_SIZE)) {
          const { data: last } = await base(
            supabase.from('wheel_spin_log').select('created_at').eq('won', true).order('created_at', { ascending: true }),
          ).range(POOL_SIZE - 1, POOL_SIZE - 1);
          if (last?.[0]?.created_at) {
            const catMs = Date.parse(last[0].created_at) + 2 * 60 * 60 * 1000;
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
        `Wins: ${totalWins} → K${state?.total_budget_spent ?? 0} / K${DAILY_BUDGET.toLocaleString('en-US')} budget`,
      ];
      if (exhaustLine) lines.push(exhaustLine);
      const ws = winsSeenLine(winsSeen, totalWins);
      if (ws) lines.push(ws);
      const ll = lossesLine(lossCounts);
      if (ll) lines.push(ll);
      lines.push(...cooldownDigestLines(cooldownBlocked, carryoverAwarded, state?.carryover_in));
      lines.push(`(errors delivered live; see alerts)`);
      text = lines.join('\n');
    }

    // Promo funnel, per site, for the same wheel-day window (07:00 UTC
    // boundaries). Counted by variant so the path links and the future real
    // domains land in the same bucket. Idle sites produce no line.
    const dayStart = new Date(`${day}T07:00:00Z`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const promoLines = [];
    for (const site of Object.values(PROMO_VARIANTS)) {
      const counts = {};
      for (const ev of ['view', 'spin', 'claim_click']) {
        const { count, error } = await supabase
          .from('promo_events')
          .select('id', { count: 'exact', head: true })
          .eq('variant', site.variant).eq('event', ev)
          .gte('created_at', dayStart.toISOString()).lt('created_at', dayEnd.toISOString());
        if (error) throw error;
        counts[ev] = count ?? 0;
      }
      const pl = promoLine(site.label, counts);
      if (pl) promoLines.push(pl);
    }
    if (promoLines.length) text = `${text}\n${promoLines.join('\n')}`;
  } catch (err) {
    readFailed = true;
    waitUntil(reportError(err, { route: 'digest', status: 500, code: 'digest_read_failed' }));
    text = `📊 Wheel daily digest — ${day}\n⚠️ digest read failed: ${(err && err.message) || 'error'}`;
  }

  const delivered = await sendTelegram({ token, chatId, text, source: 'digest' });
  if (!delivered) {
    waitUntil(reportError(new Error('digest not delivered'), { route: 'digest', status: 500, code: 'digest_send_failed' }));
  }
  // An honest status code: Vercel's cron log should show a digest that did
  // not read or did not send as a failure, not a success.
  const ok = delivered && !readFailed;
  return NextResponse.json({ ok, day }, { status: ok ? 200 : 500 });
}
