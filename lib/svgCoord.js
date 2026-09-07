// Rounds a computed SVG coordinate so the server and the browser always write
// the same attribute string.
//
// Math.cos/Math.sin are implementation-defined in ECMAScript: Vercel's Node and
// the visitor's Chrome are free to return doubles that differ in the last bit,
// and they do — the promo wheel's light at 220° came out 59.047822466108016 on
// the server and 59.047822466108045 in the browser. React compares the two
// attribute strings, fails hydration, and re-renders the entire root on the
// client; until that finishes the SPIN button on screen is inert server HTML,
// so a tap on a slow phone is silently swallowed and the wheel never spins.
//
// Three decimals is ~1e-3 of an SVG user unit on a 400-unit viewBox — far below
// a device pixel, so nothing moves visually — while the engines only ever
// disagree around 1e-14, so the difference can never reach the output.
export const SVG_COORD_DECIMALS = 3;

const FACTOR = 10 ** SVG_COORD_DECIMALS;

export function coord(n) {
  return Math.round(n * FACTOR) / FACTOR;
}
