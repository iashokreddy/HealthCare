import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Role } from '../db/schema.js';

export interface AccessClaims {
  sub: string;
  role: Role;
  /** Facility the user belongs to (staff) — drives attribute-based access control. */
  fid: string | null;
  /** Linked patient record (patients only). */
  pid: string | null;
  /** Authentication methods used: 'pwd', 'otp'. */
  amr: string[];
  /** Refresh-token family, so logout/revocation can be correlated. */
  sid: string;
}

export interface TokenService {
  signAccess(claims: AccessClaims): Promise<string>;
  verifyAccess(token: string): Promise<AccessClaims>;
  /** Short-lived token proving password was verified, exchanged for full tokens after OTP. */
  signMfaChallenge(userId: string): Promise<string>;
  verifyMfaChallenge(token: string): Promise<string>;
  publicJwk(): JsonWebKey;
}

export function createTokenService(opts: { privateKeyPem?: string; issuer: string; accessTtl: number }): TokenService {
  let priv: KeyObject;
  let pub: KeyObject;
  if (opts.privateKeyPem) {
    priv = createPrivateKey(opts.privateKeyPem);
    pub = createPublicKey(priv);
  } else {
    ({ privateKey: priv, publicKey: pub } = generateKeyPairSync('ed25519'));
  }
  const kid = randomUUID().slice(0, 8);
  const audience = 'carebridge';

  return {
    async signAccess(c) {
      return new SignJWT({ role: c.role, fid: c.fid, pid: c.pid, amr: c.amr, sid: c.sid })
        .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'at+jwt' })
        .setSubject(c.sub)
        .setIssuer(opts.issuer)
        .setAudience(audience)
        .setJti(randomUUID())
        .setIssuedAt()
        .setExpirationTime(`${opts.accessTtl}s`)
        .sign(priv);
    },
    async verifyAccess(token) {
      const { payload } = await jwtVerify(token, pub, {
        issuer: opts.issuer,
        audience,
        algorithms: ['EdDSA'],
        typ: 'at+jwt',
        clockTolerance: 5,
      });
      return {
        sub: payload.sub!,
        role: payload.role as Role,
        fid: (payload.fid as string | null) ?? null,
        pid: (payload.pid as string | null) ?? null,
        amr: (payload.amr as string[]) ?? [],
        sid: payload.sid as string,
      };
    },
    async signMfaChallenge(userId) {
      return new SignJWT({})
        .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'mfa+jwt' })
        .setSubject(userId)
        .setIssuer(opts.issuer)
        .setAudience(`${audience}:mfa`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(priv);
    },
    async verifyMfaChallenge(token) {
      const { payload } = await jwtVerify(token, pub, {
        issuer: opts.issuer,
        audience: `${audience}:mfa`,
        algorithms: ['EdDSA'],
        typ: 'mfa+jwt',
      });
      return payload.sub!;
    },
    publicJwk: () => ({ ...pub.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' }),
  };
}
