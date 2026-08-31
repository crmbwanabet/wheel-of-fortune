// Data for the readerboard above the wheel: a rotating line of simulated
// winners ("MWANSA FROM KITWE WON K200!"). Pure and injectable so the
// distribution rules are testable without a browser.
//
// Believability rules, in order of importance: names and towns a Zambian
// player recognises; prizes weighted like the real ladder (small amounts
// dominate); the jackpot line rare enough to stay special; never the same
// name twice in a row.

export const TICKER_NAMES = [
  'Abel', 'Abigail', 'Agness', 'Albert', 'Alice', 'Amos', 'Andrew', 'Angela',
  'Annie', 'Anthony', 'Astridah', 'Aubrey', 'Audrey', 'Augustine',
  'Barbara', 'Beatrice', 'Beauty', 'Bernard', 'Bertha', 'Bessy', 'Blessings',
  'Boyd', 'Brenda', 'Brian', 'Bridget', 'Bupe', 'Bwalya',
  'Caleb', 'Carol', 'Catherine', 'Chanda', 'Chansa', 'Charity', 'Charles',
  'Chewe', 'Chibwe', 'Chilando', 'Chileshe', 'Chilufya', 'Chimuka',
  'Chipego', 'Chipo', 'Chisala', 'Chisenga', 'Chisomo', 'Chitalu', 'Chola',
  'Chomba', 'Christabel', 'Christopher', 'Chrispin', 'Clement', 'Clive',
  'Comfort', 'Constance', 'Cynthia',
  'Dalitso', 'Daniel', 'Davies', 'Deborah', 'Denny', 'Derrick', 'Dingase',
  'Dorcas', 'Doreen', 'Dorothy', 'Douglas',
  'Edith', 'Edward', 'Elias', 'Elijah', 'Elizabeth', 'Emeldah', 'Emmanuel',
  'Enala', 'Ernest', 'Esnart', 'Esther', 'Ethel', 'Evans', 'Evelyn',
  'Exildah',
  'Faith', 'Felix', 'Fridah',
  'George', 'Gershom', 'Gift', 'Gladys', 'Glory', 'Grace', 'Gregory',
  'Hannah', 'Harriet', 'Harrison', 'Henry', 'Hope', 'Humphrey',
  'Idah', 'Isaac', 'Isabel',
  'Jack', 'Jacob', 'James', 'Jane', 'Janet', 'Japhet', 'Jere', 'Jessy',
  'John', 'Jonas', 'Joseph', 'Josephine', 'Joshua', 'Joyce', 'Judith',
  'Julia', 'Justina',
  'Kabwe', 'Kalaba', 'Kangwa', 'Kapembwa', 'Kasonde', 'Katongo', 'Kelvin',
  'Kondwani', 'Kunda', 'Kutemba',
  'Lackson', 'Langiwe', 'Levy', 'Lillian', 'Limpo', 'Linda', 'Lombe',
  'Loveness', 'Lubinda', 'Lucy', 'Lukundo', 'Lusungu', 'Luyando',
  'Mabvuto', 'Madalitso', 'Maggie', 'Makweti', 'Malama', 'Mapalo',
  'Margaret', 'Martha', 'Martin', 'Mary', 'Masuzyo', 'Matthews', 'Maureen',
  'Mavis', 'Maxwell', 'Mazuba', 'Melody', 'Memory', 'Mercy', 'Michael',
  'Mirriam', 'Misozi', 'Monde', 'Moses', 'Mphatso', 'Mpundu', 'Mulenga',
  'Musonda', 'Mutale', 'Mutinta', 'Muzala', 'Mwaka', 'Mwansa', 'Mwape',
  'Mwenya', 'Mwiza',
  'Naomi', 'Nasilele', 'Natasha', 'Nathan', 'Nchimunya', 'Ndanji', 'Nelly',
  'Nicholas', 'Nkandu', 'Nkumbu', 'Nosiku', 'Notulu',
  'Obed', 'Oliver', 'Owen',
  'Pamela', 'Patience', 'Patrick', 'Paul', 'Peggy', 'Peter', 'Phillip',
  'Precious', 'Prisca', 'Prudence', 'Purity',
  'Queen',
  'Rabecca', 'Rachael', 'Regina', 'Reuben', 'Rhoda', 'Richard', 'Robert',
  'Rodgers', 'Rose', 'Royd', 'Ruth',
  'Salifyanji', 'Samba', 'Samuel', 'Sandra', 'Sara', 'Sepiso', 'Serah',
  'Silvia', 'Simon', 'Solomon', 'Stella', 'Stephen', 'Suwilanji', 'Sydney',
  'Taonga', 'Tapiwa', 'Temwani', 'Thandiwe', 'Themba', 'Theresa',
  'Thokozile', 'Timothy', 'Towela', 'Trinity', 'Trust', 'Tukiya', 'Twaambo',
  'Vainess', 'Vasco', 'Vera', 'Victor', 'Victoria', 'Vincent', 'Violet',
  'Wana', 'Webster', 'Wezi', 'Whiteson', 'Wilfred', 'Wina', 'Winford',
  'Winnie',
  'Yamikani', 'Yande', 'Yvonne',
  'Zewelanji', 'Zikomo',
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

// One jackpot line in a hundred messages (owner spec 2026-08-27).
export const JACKPOT_CHANCE = 0.01;
export const JACKPOT_PRIZE = 10000;

// Message cadence: fixed 2s (owner spec 2026-08-25); a jackpot line holds a
// second longer so the rare flash gets read (owner spec 2026-08-27).
export const TICKER_INTERVAL_MS = 2000;
export const JACKPOT_INTERVAL_MS = 3000;

function pick(list, rnd) {
  return list[Math.min(list.length - 1, Math.floor(rnd() * list.length))];
}

// Next simulated winner: first name + surname (260+ names x 40 surnames, and
// the board shows NAME.INITIAL — thousands of distinct displayed identities,
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

// Delay before replacing the CURRENTLY SHOWN winner.
export function nextDelayMs(currentWinner) {
  return currentWinner && currentWinner.jackpot ? JACKPOT_INTERVAL_MS : TICKER_INTERVAL_MS;
}
