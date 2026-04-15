const store = new Map();

export function checkRateLimit(ip, maxRequests = 5, windowMs = 60_000) {
  const now = Date.now();
  const key = ip;

  if (!store.has(key)) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  const entry = store.get(key);

  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + windowMs;
    return true;
  }

  entry.count++;
  return entry.count <= maxRequests;
}
