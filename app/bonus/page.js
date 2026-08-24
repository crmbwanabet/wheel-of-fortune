import { getPromoVariant } from '@/lib/promoConfig';
import PromoWheel from '@/components/PromoWheel';

// The existing-customer promo site on its own shareable path — the interim
// link until its real domain exists (then the domain root serves the same thing).
export { metadata, viewport } from '@/app/promo/layout';

export default function BonusPage() {
  return <PromoWheel site={getPromoVariant('existing')} />;
}
