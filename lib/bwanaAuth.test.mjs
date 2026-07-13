import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyBwanaToken, decodeJwtPayload, TokenError } from './bwanaAuth.mjs';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const makeToken = (payload) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;

// Build a token with a genuine HS256 signature over header.payload.
const makeSignedToken = (payload, secret, header = { alg: 'HS256', typ: 'JWT' }) => {
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const sig = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
};

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

test('verifyBwanaToken returns identity for a valid token', () => {
  const token = makeToken({ id: 207978, phone: '+260779613904', currency: 'K', exp: FUTURE });
  const ident = verifyBwanaToken(token);
  assert.equal(ident.id, '207978');
  assert.equal(ident.phone, '+260779613904');
  assert.equal(ident.currency, 'K');
  assert.equal(ident.exp, FUTURE);
});

test('verifyBwanaToken throws expired for a past exp', () => {
  const token = makeToken({ id: 207978, exp: PAST });
  assert.throws(() => verifyBwanaToken(token), (e) => e instanceof TokenError && e.code === 'expired');
});

test('verifyBwanaToken throws expired when exp is missing', () => {
  const token = makeToken({ id: 207978 });
  assert.throws(() => verifyBwanaToken(token), (e) => e.code === 'expired');
});

test('verifyBwanaToken throws no_id when id is absent', () => {
  const token = makeToken({ phone: '+260', exp: FUTURE });
  assert.throws(() => verifyBwanaToken(token), (e) => e.code === 'no_id');
});

test('verifyBwanaToken throws malformed for non-JWT strings', () => {
  assert.throws(() => verifyBwanaToken('not-a-jwt'), (e) => e.code === 'malformed');
  assert.throws(() => verifyBwanaToken(''), (e) => e.code === 'malformed');
  assert.throws(() => verifyBwanaToken(null), (e) => e.code === 'malformed');
});

test('decodeJwtPayload throws malformed on unparseable payload', () => {
  assert.throws(() => decodeJwtPayload('aaa.!!!notbase64json!!!.sig'), (e) => e.code === 'malformed');
});

test('verifyBwanaToken throws no_id when id is a non-scalar (object)', () => {
  const token = makeToken({ id: { a: 1 }, exp: FUTURE });
  assert.throws(() => verifyBwanaToken(token), (e) => e.code === 'no_id');
});

test('verifyBwanaToken accepts id 0 and returns "0"', () => {
  const token = makeToken({ id: 0, exp: FUTURE });
  assert.equal(verifyBwanaToken(token).id, '0');
});

test('decodeJwtPayload returns the payload object for a valid token', () => {
  const token = makeToken({ id: 5, exp: FUTURE });
  assert.equal(decodeJwtPayload(token).id, 5);
});

// --- Phase 2: HS256 signature verification (env-gated) ---

const withSignatureVerification = (secret, fn) => {
  const prevFlag = process.env.BWANA_VERIFY_SIGNATURE;
  const prevSecret = process.env.BWANA_JWT_SECRET;
  process.env.BWANA_VERIFY_SIGNATURE = '1';
  process.env.BWANA_JWT_SECRET = secret;
  try {
    fn();
  } finally {
    if (prevFlag === undefined) delete process.env.BWANA_VERIFY_SIGNATURE;
    else process.env.BWANA_VERIFY_SIGNATURE = prevFlag;
    if (prevSecret === undefined) delete process.env.BWANA_JWT_SECRET;
    else process.env.BWANA_JWT_SECRET = prevSecret;
  }
};

test('Phase 2: accepts a correctly HS256-signed token', () => {
  const secret = 'test-signing-secret';
  const token = makeSignedToken({ id: 207978, exp: FUTURE }, secret);
  withSignatureVerification(secret, () => {
    assert.equal(verifyBwanaToken(token).id, '207978');
  });
});

test('Phase 2: rejects a token signed with the wrong secret', () => {
  const token = makeSignedToken({ id: 207978, exp: FUTURE }, 'attacker-secret');
  withSignatureVerification('real-secret', () => {
    assert.throws(() => verifyBwanaToken(token), (e) => e instanceof TokenError && e.code === 'bad_signature');
  });
});

test('Phase 2: rejects a Phase-1 style token with a fake "sig" segment', () => {
  const token = makeToken({ id: 207978, exp: FUTURE }); // signature is the literal "sig"
  withSignatureVerification('real-secret', () => {
    assert.throws(() => verifyBwanaToken(token), (e) => e.code === 'bad_signature');
  });
});

test('Phase 2: rejects an alg:none token even with a matching-looking payload', () => {
  const secret = 'real-secret';
  // Attacker sets alg:none and an empty signature; must still be rejected.
  const signingInput = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ id: 1, exp: FUTURE })}`;
  const token = `${signingInput}.`;
  withSignatureVerification(secret, () => {
    assert.throws(() => verifyBwanaToken(token), (e) => e.code === 'malformed' || e.code === 'bad_signature');
  });
});

test('Phase 1 (flag off) still accepts an unsigned token', () => {
  const token = makeToken({ id: 42, exp: FUTURE });
  assert.equal(verifyBwanaToken(token).id, '42'); // BWANA_VERIFY_SIGNATURE unset
});
