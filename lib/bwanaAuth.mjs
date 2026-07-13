// Verification of the BwanaBet session JWT.
//
// Phase 1 (default): decode-only — read `id`, enforce `exp`, no signature check.
// Phase 2: set BWANA_VERIFY_SIGNATURE=1 and BWANA_JWT_SECRET=<HS256 secret> to
// additionally require a valid HS256 signature. Flipping phases is env-only;
// no caller changes. See spec §5.3.

import { createHmac, timingSafeEqual } from 'node:crypto';

export class TokenError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TokenError';
    this.code = code; // 'malformed' | 'expired' | 'no_id' | 'bad_signature'
  }
}

function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

// Recompute the HS256 signature over `header.payload` and compare it, in
// constant time, to the signature the token carries. The token's own `alg`
// header is never trusted — we always require a valid HS256 signature — so
// `alg: none` and algorithm-confusion attacks fail the comparison.
function assertValidHs256Signature(rawToken, secret) {
  if (typeof secret !== 'string' || secret === '') throw new TokenError('bad_signature');
  const parts = rawToken.split('.');
  if (parts.length !== 3 || !parts[2]) throw new TokenError('malformed');
  const [header, payload, providedSig] = parts;
  const expectedSig = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new TokenError('bad_signature');
  }
}

export function decodeJwtPayload(rawToken) {
  if (typeof rawToken !== 'string' || rawToken === '') throw new TokenError('malformed');
  const parts = rawToken.split('.');
  if (parts.length !== 3 || !parts[1]) throw new TokenError('malformed');
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    throw new TokenError('malformed');
  }
  if (!payload || typeof payload !== 'object') throw new TokenError('malformed');
  return payload;
}

export function verifyBwanaToken(rawToken, { now = Date.now() } = {}) {
  const payload = decodeJwtPayload(rawToken);

  // --- Phase 2: cryptographic verification (env-gated) ---
  if (process.env.BWANA_VERIFY_SIGNATURE === '1') {
    assertValidHs256Signature(rawToken, process.env.BWANA_JWT_SECRET);
  }
  // -------------------------------------------------------

  if (
    (typeof payload.id !== 'string' && typeof payload.id !== 'number') ||
    payload.id === ''
  ) {
    throw new TokenError('no_id');
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) {
    throw new TokenError('expired');
  }

  return {
    id: String(payload.id),
    phone: payload.phone ?? null,
    currency: payload.currency ?? null,
    exp: payload.exp,
  };
}
