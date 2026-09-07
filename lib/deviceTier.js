// Whether to drop the wheel's expensive SVG filters and SMIL animation.
//
// Kept out of the component because WHERE the question is asked matters more
// than the answer. Node 21+ ships a global `navigator` carrying
// hardwareConcurrency, so a check like `navigator.hardwareConcurrency <= 4`
// inside a render also runs on Vercel — and on Vercel it says "low end", so the
// server sent every visitor the cheap 18-light tree while their phone rendered
// the 36-light one on hydration. React cannot reconcile that: it discards the
// server DOM and re-renders the entire root (#418/#423), and until that lands
// the SPIN button on screen is inert markup with no handler attached, so taps
// on a slow phone are swallowed and the wheel appears not to spin.
//
// The rule is therefore: first render is fixed, tier is applied after mount.

// What both the server and the first client render must draw. The cheap tree,
// so the weakest phones — the ones this promo is aimed at — never build the
// heavy one at all; capable devices upgrade a frame later, once mounted.
export const LOW_END_FIRST_RENDER = true;

export function isLowEndDevice(nav) {
  if (!nav) return true;
  const cores = nav.hardwareConcurrency || 8;
  const mem = nav.deviceMemory || 8;
  return cores <= 4 || mem <= 3;
}
