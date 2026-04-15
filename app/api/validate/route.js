import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { checkRateLimit } from '@/lib/rateLimit';

export async function POST(request) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ valid: false, error: 'Too many requests' }, { status: 429 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ valid: false, error: 'Invalid request body' }, { status: 400 });
  }

  const { customerId } = body;

  if (!customerId || typeof customerId !== 'string' || customerId.trim() === '') {
    return NextResponse.json({ valid: false, error: 'Customer ID is required' }, { status: 400 });
  }

  const cleanId = customerId.trim();

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('customers')
    .select('id')
    .eq('id', cleanId)
    .limit(1)
    .single();

  if (error || !data) {
    return NextResponse.json({ valid: false, error: 'Invalid Customer ID' });
  }

  return NextResponse.json({ valid: true });
}
