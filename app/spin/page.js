import { getPromoVariant } from '@/lib/promoConfig';
import PromoWheel from '@/components/PromoWheel';

// The new-player promo site on its own shareable path — the interim link
// until its real domain exists (then the domain root serves the same thing).
export { metadata, viewport } from '@/app/promo/layout';

export default function SpinPage() {
  return <PromoWheel site={getPromoVariant('new')} />;
}
