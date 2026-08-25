// Data for the readerboard above the wheel: a rotating line of simulated
// winners ("MWANSA FROM KITWE WON K200!"). Pure and injectable so the
// distribution rules are testable without a browser.
//
// Believability rules, in order of importance: names and towns a Zambian
// player recognises; prizes weighted like the real ladder (small amounts
// dominate); the jackpot line rare enough to stay special; timing jittered so
// the board never ticks like a clock; never the same name twice in a row.

export const TICKER_NAMES = [
  'Mwansa', 'Chanda', 'Bwalya', 'Mutale', 'Chileshe', 'Musonda', 'Kunda',
  'Chomba', 'Mapalo', 'Mulenga', 'Lombe', 'Kabwe', 'Nchimunya', 'Temwani',
  'Thandiwe', 'Zikomo', 'Chisomo', 'Dalitso', 'Mphatso', 'Kondwani',
  'Natasha', 'Gift', 'Precious', 'Blessings', 'Beatrice', 'Moses', 'Esther',
  'Ruth', 'Joseph', 'Emmanuel', 'Mercy', 'Faith', 'Charity', 'Memory',
  'Loveness', 'Gladys', 'Brian', 'Kelvin', 'Astridah', 'Webster',
];

export const TICKER_TOWNS = [
  'Lusaka', 'Kitwe', 'Ndola', 'Kabwe', 'Chingola', 'Mufulira', 'Livingstone',
  'Luanshya', 'Kasama', 'Chipata', 'Solwezi', 'Mazabuka', 'Choma', 'Mongu',
];

// Weighted like the real ladder: small prizes dominate, K200 is scarce.
export const TICKER_PRIZES = [5, 5, 5, 10, 10, 10, 20, 20, 50, 50, 100, 200];

// Roughly one jackpot line in 17 messages.
export const JACKPOT_CHANCE = 0.06;
export const JACKPOT_PRIZE = 10000;

// Message cadence: 3.8s..6.4s, uniformly jittered.
export const DELAY_MIN_MS = 3800;
export const DELAY_SPREAD_MS = 2600;

function pick(list, rnd) {
  return list[Math.min(list.length - 1, Math.floor(rnd() * list.length))];
}

// Next simulated winner. `prevName` never repeats: on a collision the pick
// advances one slot instead of re-rolling, so a stuck RNG cannot loop forever.
export function nextWinner(prevName, rnd = Math.random) {
  let name = pick(TICKER_NAMES, rnd);
  if (name === prevName) {
    name = TICKER_NAMES[(TICKER_NAMES.indexOf(name) + 1) % TICKER_NAMES.length];
  }
  const town = pick(TICKER_TOWNS, rnd);
  if (rnd() < JACKPOT_CHANCE) return { name, town, prize: JACKPOT_PRIZE, jackpot: true };
  return { name, town, prize: pick(TICKER_PRIZES, rnd), jackpot: false };
}

export function nextDelayMs(rnd = Math.random) {
  return DELAY_MIN_MS + Math.floor(rnd() * DELAY_SPREAD_MS);
}
