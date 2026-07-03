import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyBwanaToken, decodeJwtPayload, TokenError } from './bwanaAuth.mjs';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const makeToken = (payload) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;

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
