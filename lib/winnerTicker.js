// Data for the readerboard above the wheel: a rotating line of simulated
// winners ("MWANSA FROM KITWE WON K200!"). Pure and injectable so the
// distribution rules are testable without a browser.
//
// Believability rules, in order of importance: names and towns a Zambian
// player recognises; prizes weighted like the real ladder (small amounts
// dominate); the jackpot line rare enough to stay special; never the same
// name twice in a row.

export const TICKER_NAMES = [
  'Mwansa', 'Chanda', 'Bwalya', 'Mutale', 'Chileshe', 'Musonda', 'Kunda',
  'Chomba', 'Mapalo', 'Mulenga', 'Lombe', 'Kabwe', 'Nchimunya', 'Temwani',
  'Thandiwe', 'Zikomo', 'Chisomo', 'Dalitso', 'Mphatso', 'Kondwani',
  'Natasha', 'Gift', 'Precious', 'Blessings', 'Beatrice', 'Moses', 'Esther',
  'Ruth', 'Joseph', 'Emmanuel', 'Mercy', 'Faith', 'Charity', 'Memory',
  'Loveness', 'Gladys', 'Brian', 'Kelvin', 'Astridah', 'Webster',
];

export const TICKER_SURNAMES = [
  'Phiri', 'Banda', 'Mwanza', 'Tembo', 'Mumba', 'Zulu', 'Sakala', 'Ngoma',
  'Lungu', 'Mwila', 'Daka', 'Nyirenda', 'Sichone', 'Simukonda', 'Kasonde',
  'Chishimba', 'Mwape', 'Kalaba', 'Chirwa', 'Mvula', 'Soko', 'Njobvu',
  'Mbewe', 'Siame', 'Katongo', 'Chibwe', 'Sinkala', 'Malama', 'Kangwa',
  'Chola', 'Chewe', 'Mpundu', 'Musenge', 'Kapembwa', 'Simbeye', 'Mulonga',
  'Hamoonga', 'Michelo', 'Habeenzu', 'Moonga',
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

// Message cadence: fixed 2s (owner spec 2026-08-25).
export const TICKER_INTERVAL_MS = 2000;

function pick(list, rnd) {
  return list[Math.min(list.length - 1, Math.floor(rnd() * list.length))];
}

// Next simulated winner: first name + surname (40x40 = 1,600 distinct people,
// so a viewer rarely sees the same person twice). `prevName` (the previous
// FIRST name) never repeats back-to-back: on a collision the pick advances one
// slot instead of re-rolling, so a stuck RNG cannot loop forever.
export function nextWinner(prevName, rnd = Math.random) {
  let name = pick(TICKER_NAMES, rnd);
  if (name === prevName) {
    name = TICKER_NAMES[(TICKER_NAMES.indexOf(name) + 1) % TICKER_NAMES.length];
  }
  const surname = pick(TICKER_SURNAMES, rnd);
  const town = pick(TICKER_TOWNS, rnd);
  if (rnd() < JACKPOT_CHANCE) return { name, surname, town, prize: JACKPOT_PRIZE, jackpot: true };
  return { name, surname, town, prize: pick(TICKER_PRIZES, rnd), jackpot: false };
}

export function nextDelayMs() {
  return TICKER_INTERVAL_MS;
}
