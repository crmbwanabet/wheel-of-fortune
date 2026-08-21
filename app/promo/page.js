import { headers } from 'next/headers';
import { resolvePromoSite } from '@/lib/promoConfig';
import PromoWheel from '@/components/PromoWheel';

export const dynamic = 'force-dynamic';

// Which promo site to render is decided by the Host header — see
// lib/promoConfig.js. Unknown hosts (previews, localhost) get the default.
export default function PromoPage() {
  const site = resolvePromoSite(headers().get('host'));
  return <PromoWheel site={site} />;
}
