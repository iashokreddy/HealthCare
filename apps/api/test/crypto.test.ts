import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  base32Decode,
  base32Encode,
  blindIndex,
  createKeyring,
  decryptField,
  encryptField,
  hashPassword,
  totpAt,
  verifyPassword,
  verifyTotp,
} from '../src/lib/crypto.js';

test('field encryption round-trips and binds context', () => {
  const ring = createKeyring();
  const ct = encryptField(ring, 'Jordan Rivera', 'patients:1:name');
  assert.notEqual(ct, encryptField(ring, 'Jordan Rivera', 'patients:1:name'), 'ciphertext must be randomised');
  assert.equal(decryptField(ring, ct, 'patients:1:name'), 'Jordan Rivera');
  assert.throws(() => decryptField(ring, ct, 'patients:2:name'), 'ciphertext must not move between rows');
});

test('tampered ciphertext is rejected', () => {
  const ring = createKeyring();
  const parts = encryptField(ring, 'secret', 'x').split('.');
  const last = Buffer.from(parts[5]!, 'base64url');
  last[0]! ^= 1;
  parts[5] = last.toString('base64url');
  assert.throws(() => decryptField(ring, parts.join('.'), 'x'));
});

test('blind index is deterministic and normalised, keyed per ring', () => {
  const ring = createKeyring();
  assert.equal(blindIndex(ring, ' A@B.com ', 'email'), blindIndex(ring, 'a@b.com', 'email'));
  assert.notEqual(blindIndex(ring, 'a@b.com', 'email'), blindIndex(ring, 'a@b.com', 'mrn'));
  assert.notEqual(blindIndex(createKeyring(), 'a@b.com', 'email'), blindIndex(ring, 'a@b.com', 'email'));
});

test('password hashing', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(await verifyPassword('correct horse battery', h));
  assert.ok(!(await verifyPassword('wrong', h)));
});

test('TOTP matches RFC 6238 test vector and rejects replay', () => {
  // RFC 6238 SHA-1 secret "12345678901234567890", T=59s → 94287082 (8 digits) → last 6 = 287082
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(totpAt(secret, 1), '287082');
  const now = 59_000;
  const counter = verifyTotp(secret, '287082', null, now);
  assert.equal(counter, 1);
  assert.equal(verifyTotp(secret, '287082', counter, now), null, 'same code must not be accepted twice');
});
