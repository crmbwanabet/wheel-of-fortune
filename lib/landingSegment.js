// Where the wheel should visually stop, given the server's segment index.
//
// The server is the authority on win/loss and prize amount; this only decides
// which slice the pointer rests on. Anything unrenderable — the display-only
// jackpot, an out-of-range index, or an index from a mismatched bundle
// version — is substituted with a loss slice so the widget never crashes and
// never shows the jackpot as a landing.
//
// Imports from wheelSegments.js, NOT algorithms.js — this module is pulled
// into the client bundle by WheelWidget, and algorithms.js carries the day's
// prize distribution, which must never reach the browser.

import { WIN_SEGMENTS, LOSS_SEGMENTS } from './wheelSegments.js';

const RENDERABLE = new Set([...WIN_SEGMENTS, ...LOSS_SEGMENTS]);

export function resolveLandingSegment(segmentIndex, rng = Math.random) {
  if (Number.isInteger(segmentIndex) && RENDERABLE.has(segmentIndex)) {
    return { index: segmentIndex, substituted: false };
  }
  const i = Math.min(LOSS_SEGMENTS.length - 1, Math.floor(rng() * LOSS_SEGMENTS.length));
  return { index: LOSS_SEGMENTS[i], substituted: true };
}
