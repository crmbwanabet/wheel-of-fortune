import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rateLimit';
import {
  getWheelDayDate,
  pickAlgorithm,
  buildWinningMap,
  prizeToSegmentIndex,
  pickLossSegment,
} from '@/lib/algorithms';
import { sendWinNotification } from '@/lib/telegram';

async function getOrCreateDailyState(dayDate) {
  const { data: existing } = await supabase
    .from('wheel_daily_state')
    .select('*')
    .eq('day_date', dayDate)
    .single();

  if (existing) return existing;

  const algorithmId = pickAlgorithm();
  const winningPositions = buildWinningMap(algorithmId);

  const { data: created, error } = await supabase
    .from('wheel_daily_state')
    .upsert(
      {
        day_date: dayDate,
        algorithm_id: algorithmId,
        winning_positions: winningPositions,
        total_spins: 0,
        total_wins: 0,
        total_budget_spent: 0,
      },
      { onConflict: 'day_date', ignoreDuplicates: true }
    )
    .select()
    .single();

  if (error || !created) {
    const { data: fetched } = await supabase
      .from('wheel_daily_state')
      .select('*')
      .eq('day_date', dayDate)
      .single();
    return fetched;
  }

  return created;
}

export async function POST(request) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const { customerId, fingerprint } = body;

  if (!customerId || typeof customerId !== 'string' || customerId.trim() === '') {
    return NextResponse.json({ error: 'missing_customer_id' }, { status: 400 });
  }

  const cleanId = customerId.trim();
  const dayDate = getWheelDayDate();

  // Check: has this customer already spun today?
  const { data: existingSpin } = await supabase
    .from('wheel_spin_log')
    .select('id')
    .eq('day_date', dayDate)
    .eq('customer_id', cleanId)
    .limit(1)
    .single();

  if (existingSpin) {
    return NextResponse.json({ error: 'already_spun' });
  }

  // Check: has this fingerprint already spun today?
  if (fingerprint) {
    const { data: fpSpin } = await supabase
      .from('wheel_spin_log')
      .select('id')
      .eq('day_date', dayDate)
      .eq('fingerprint', fingerprint)
      .limit(1)
      .single();

    if (fpSpin) {
      return NextResponse.json({ error: 'already_spun' });
    }
  }

  // Get or create today's state
  const dailyState = await getOrCreateDailyState(dayDate);
  if (!dailyState) {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  // Atomically increment total_spins and get the new spin number
  const { data: updated, error: updateErr } = await supabase
    .from('wheel_daily_state')
    .update({ total_spins: dailyState.total_spins + 1 })
    .eq('id', dailyState.id)
    .eq('total_spins', dailyState.total_spins)
    .select('total_spins')
    .single();

  if (updateErr || !updated) {
    const { data: retryState } = await supabase
      .from('wheel_daily_state')
      .select('*')
      .eq('day_date', dayDate)
      .single();

    if (!retryState) {
      return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }

    const { data: retryUpdated, error: retryErr } = await supabase
      .from('wheel_daily_state')
      .update({ total_spins: retryState.total_spins + 1 })
      .eq('id', retryState.id)
      .eq('total_spins', retryState.total_spins)
      .select('total_spins')
      .single();

    if (retryErr || !retryUpdated) {
      return NextResponse.json({ error: 'server_busy' }, { status: 503 });
    }

    Object.assign(dailyState, retryState);
    dailyState.total_spins = retryUpdated.total_spins;
  } else {
    dailyState.total_spins = updated.total_spins;
  }

  const spinNumber = dailyState.total_spins;
  const winningPositions = dailyState.winning_positions;

  const prizeAmount = winningPositions[String(spinNumber)];
  const isWin = prizeAmount !== undefined;

  let segmentIndex;
  let finalPrize = 0;

  if (isWin) {
    segmentIndex = prizeToSegmentIndex(prizeAmount);
    finalPrize = prizeAmount;

    await supabase
      .from('wheel_daily_state')
      .update({
        total_wins: dailyState.total_wins + 1,
        total_budget_spent: dailyState.total_budget_spent + prizeAmount,
      })
      .eq('id', dailyState.id);

    sendWinNotification({
      customerId: cleanId,
      prizeAmount,
      winsToday: dailyState.total_wins + 1,
      budgetSpent: dailyState.total_budget_spent + prizeAmount,
    }).catch(() => {});
  } else {
    segmentIndex = pickLossSegment();
  }

  await supabase.from('wheel_spin_log').insert({
    day_date: dayDate,
    customer_id: cleanId,
    spin_number: spinNumber,
    won: isWin,
    prize_amount: finalPrize,
    segment_index: segmentIndex,
    fingerprint: fingerprint || null,
    ip_address: ip,
  });

  return NextResponse.json({
    win: isWin,
    segmentIndex,
    prize: isWin ? { kwacha: prizeAmount } : null,
  });
}
