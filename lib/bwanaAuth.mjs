// Decode-only (Phase 1) verification of the BwanaBet session JWT.
//
// Phase 2 will add HS256 signature verification at the marked seam below,
// gated by BWANA_VERIFY_SIGNATURE / BWANA_JWT_SECRET, without changing this
// module's public shape or any caller. See spec §5.3.

export class TokenError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TokenError';
    this.code = code; // 'malformed' | 'expired' | 'no_id'
  }
}

function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
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

  // --- Phase 2 seam ---
  // if (process.env.BWANA_VERIFY_SIGNATURE === '1') {
  //   assertValidHs256Signature(rawToken, process.env.BWANA_JWT_SECRET);
  // }
  // --------------------

  if (payload.id === undefined || payload.id === null || payload.id === '') {
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
