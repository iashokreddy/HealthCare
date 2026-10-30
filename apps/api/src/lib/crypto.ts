import {
  createCipheriv,
  createHash,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

// ---------------------------------------------------------------------------
// Field-level envelope encryption for PHI (AES-256-GCM)
// ---------------------------------------------------------------------------
//
// Each value is encrypted with a fresh data-encryption key (DEK); the DEK is wrapped with the
// key-encryption key (KEK). Rotating the KEK only requires re-wrapping DEKs, and a database
// dump alone reveals nothing. Ciphertext format (base64url, dot separated):
//   v1.<kekId>.<wrapIv>.<wrappedDek+tag>.<iv>.<ciphertext+tag>
// The record's context string (e.g. "patients:<id>:name") is bound as AAD so ciphertexts
// cannot be swapped between rows or columns.

export interface Keyring {
  activeKekId: string;
  keks: Map<string, Buffer>;
  blindIndexKey: Buffer;
}

export function createKeyring(kekB64?: string, blindB64?: string): Keyring {
  const kek = kekB64 ? decodeKey(kekB64, 'DATA_KEK') : randomBytes(32);
  const blind = blindB64 ? decodeKey(blindB64, 'BLIND_INDEX_KEY') : randomBytes(32);
  const id = createHmac('sha256', kek).update('kek-id').digest('hex').slice(0, 8);
  return { activeKekId: id, keks: new Map([[id, kek]]), blindIndexKey: blind };
}

function decodeKey(b64: string, name: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64 encoded`);
  return key;
}

const b64u = (b: Buffer) => b.toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv, ct };
}

function gcmDecrypt(key: Buffer, iv: Buffer, ctWithTag: Buffer, aad: Buffer) {
  const tag = ctWithTag.subarray(ctWithTag.length - 16);
  const ct = ctWithTag.subarray(0, ctWithTag.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export function encryptField(ring: Keyring, plaintext: string, context: string): string {
  const kek = ring.keks.get(ring.activeKekId)!;
  const dek = randomBytes(32);
  const aad = Buffer.from(context, 'utf8');
  const wrapped = gcmEncrypt(kek, dek, aad);
  const data = gcmEncrypt(dek, Buffer.from(plaintext, 'utf8'), aad);
  dek.fill(0);
  return ['v1', ring.activeKekId, b64u(wrapped.iv), b64u(wrapped.ct), b64u(data.iv), b64u(data.ct)].join('.');
}

export function decryptField(ring: Keyring, token: string, context: string): string {
  const parts = token.split('.');
  if (parts.length !== 6 || parts[0] !== 'v1') throw new Error('Malformed ciphertext');
  const [, kekId, wIv, wCt, iv, ct] = parts as [string, string, string, string, string, string];
  const kek = ring.keks.get(kekId);
  if (!kek) throw new Error('Unknown key id');
  const aad = Buffer.from(context, 'utf8');
  const dek = gcmDecrypt(kek, unb64u(wIv), unb64u(wCt), aad);
  try {
    return gcmDecrypt(dek, unb64u(iv), unb64u(ct), aad).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/** Deterministic keyed hash for exact-match lookups on encrypted columns (e.g. MRN, email). */
export function blindIndex(ring: Keyring, value: string, domain: string): string {
  return createHmac('sha256', ring.blindIndexKey).update(`${domain}:${value.trim().toLowerCase()}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt, memory-hard; parameters encoded for future upgrades)
// ---------------------------------------------------------------------------

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64u(salt)}$${b64u(key)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = unb64u(hash);
  const key = await scrypt(password.normalize('NFKC'), unb64u(salt), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(key, expected);
}

/** A real hash of a random password, used to keep login timing constant for unknown users. */
export const DUMMY_PASSWORD_HASH = await hashPassword(randomBytes(16).toString('hex'));

// ---------------------------------------------------------------------------
// TOTP (RFC 6238) for multi-factor authentication
// ---------------------------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secretB32: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

/**
 * Verifies a code within ±1 step of clock drift. Returns the matched counter so the caller can
 * reject reuse of the same (or an earlier) code — prevents replay of an observed OTP.
 */
export function verifyTotp(secretB32: string, code: string, lastUsedCounter: number | null, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 1000 / 30);
  for (const c of [current - 1, current, current + 1]) {
    if (lastUsedCounter !== null && c <= lastUsedCounter) continue;
    if (timingSafeEqual(Buffer.from(totpAt(secretB32, c)), Buffer.from(code))) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

export const randomToken = (bytes = 32) => b64u(randomBytes(bytes));

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function hmacHex(key: string | Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}
