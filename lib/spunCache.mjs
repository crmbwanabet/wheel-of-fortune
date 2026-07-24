// Per-account "already spun today" cache, persisted in localStorage as a map
// of { "<customerId>": "<wheelDay>" }. Scoping by customerId (not device) is
// what lets multiple accounts share one browser/computer — each account gets
// its own daily entry. Entries from previous wheel-days are pruned on write.

function parse(raw) {
  if (!raw) return {};
  try {
    const map = JSON.parse(raw);
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

export function hasSpun(raw, customerId, today) {
  if (!customerId) return false;
  return parse(raw)[customerId] === today;
}

export function withSpun(raw, customerId, today) {
  const map = parse(raw);
  const next = {};
  for (const [id, day] of Object.entries(map)) {
    if (day === today) next[id] = day; // keep only today's entries
  }
  if (customerId) next[customerId] = today;
  return JSON.stringify(next);
}
