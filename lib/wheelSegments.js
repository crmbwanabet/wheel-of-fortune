// Wheel segment index constants. Deliberately free of prize amounts so the
// client bundle can import it without exposing the day's prize distribution.
//
// 14 segments: even indices 0..10 are the six real prizes in ascending order,
// index 12 is the DISPLAY-ONLY K10,000 jackpot, odd indices are losses.
// Index 12 is in neither reachable set, so no server path can select it.
// See lib/jackpotSafety.test.mjs for the full proof.
export const SEGMENT_COUNT = 14;
export const JACKPOT_SEGMENT_INDEX = 12;
export const WIN_SEGMENTS = [0, 2, 4, 6, 8, 10];
export const LOSS_SEGMENTS = [1, 3, 5, 7, 9, 11, 13];
