import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { UsersTable } from '../db/schema.js';
import { currentUser, guard } from '../lib/auth.js';
import {
  blindIndex,
  decryptField,
  DUMMY_PASSWORD_HASH,
  encryptField,
  generateTotpSecret,
  randomToken,
  sha256,
  verifyPassword,
  verifyTotp,
} from '../lib/crypto.js';
import { conflict, HttpError, nowIso, unauthorized } from '../lib/http.js';

const REFRESH_COOKIE = 'cb_rt';
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

const loginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  client: z.enum(['web', 'mobile']).default('web'),
});
const mfaVerifyBody = z.object({
  mfaToken: z.string().min(1).max(2048),
  code: z.string().regex(/^\d{6}$/),
  client: z.enum(['web', 'mobile']).default('web'),
});
const refreshBody = z.object({ refreshToken: z.string().max(512).optional() }).default({});

const invalidCredentials = () => new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

export function authRoutes(ctx: AppContext) {
  const { db, ring, cfg, tokens, audit } = ctx;
  const secureCookie = cfg.NODE_ENV !== 'development';

  async function issueSession(
    req: FastifyRequest,
    reply: FastifyReply,
    user: UsersTable,
    amr: string[],
    client: 'web' | 'mobile',
    familyId: string = randomUUID(),
  ) {
    const refreshToken = randomToken(48);
    await db
      .insertInto('refresh_tokens')
      .values({
        id: randomUUID(),
        user_id: user.id,
        family_id: familyId,
        token_hash: sha256(refreshToken),
        amr: amr.join(','),
        expires_at: new Date(Date.now() + cfg.REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString(),
        revoked_at: null,
        replaced_by: null,
        created_at: nowIso(),
        user_agent: (req.headers['user-agent'] ?? '').slice(0, 256) || null,
      })
      .execute();
    const accessToken = await tokens.signAccess({
      sub: user.id,
      role: user.role,
      fid: user.facility_id,
      pid: user.patient_id,
      amr,
      sid: familyId,
    });
    if (client === 'web') {
      // Browser: refresh token lives only in an HttpOnly, SameSite=Strict cookie scoped to /auth —
      // unreachable from JavaScript, so XSS cannot exfiltrate it.
      reply.setCookie(REFRESH_COOKIE, refreshToken, {
        httpOnly: true,
        secure: secureCookie,
        sameSite: 'strict',
        path: '/api/v1/auth',
        maxAge: cfg.REFRESH_TOKEN_TTL_SECONDS,
      });
    }
    return {
      accessToken,
      expiresIn: cfg.ACCESS_TOKEN_TTL_SECONDS,
      // Mobile: returned once and stored in the OS keychain / keystore (expo-secure-store).
      refreshToken: client === 'mobile' ? refreshToken : undefined,
      user: profile(user),
    };
  }

  function profile(u: UsersTable) {
    return {
      id: u.id,
      email: decryptField(ring, u.email_enc, `users:${u.id}:email`),
      displayName: u.display_name,
      role: u.role,
      facilityId: u.facility_id,
      patientId: u.patient_id,
      mfaEnabled: u.mfa_enabled === 1,
    };
  }

  async function registerFailure(user: UsersTable) {
    const failed = user.failed_logins + 1;
    await db
      .updateTable('users')
      .set({
        failed_logins: failed,
        locked_until: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString() : user.locked_until,
      })
      .where('id', '=', user.id)
      .execute();
  }

  const isLocked = (u: UsersTable) => !!u.locked_until && new Date(u.locked_until).getTime() > Date.now();

  return async function register(app: FastifyInstance) {
    const strictLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

    app.post('/login', { config: strictLimit }, async (req, reply) => {
      const body = loginBody.parse(req.body);
      const user = await db
        .selectFrom('users')
        .selectAll()
        .where('email_bidx', '=', blindIndex(ring, body.email, 'email'))
        .executeTakeFirst();

      // Always run a full hash verification so response time doesn't reveal whether the account exists.
      const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_PASSWORD_HASH);

      if (!user || !ok || user.disabled || isLocked(user)) {
        if (user && !ok) await registerFailure(user);
        await audit.record({
          actorId: user?.id ?? null,
          actorRole: user?.role ?? null,
          action: 'auth.login',
          resourceType: 'session',
          outcome: 'denied',
          ip: req.ip,
          detail: { reason: !user ? 'unknown_user' : isLocked(user) ? 'locked' : user.disabled ? 'disabled' : 'bad_password' },
        });
        throw invalidCredentials();
      }

      await db.updateTable('users').set({ failed_logins: 0, locked_until: null }).where('id', '=', user.id).execute();

      if (user.mfa_enabled) {
        return { mfaRequired: true, mfaToken: await tokens.signMfaChallenge(user.id) };
      }
      await audit.record({ actorId: user.id, actorRole: user.role, action: 'auth.login', resourceType: 'session', ip: req.ip, detail: { amr: ['pwd'] } });
      return issueSession(req, reply, user, ['pwd'], body.client);
    });

    app.post('/mfa/verify', { config: strictLimit }, async (req, reply) => {
      const body = mfaVerifyBody.parse(req.body);
      let userId: string;
      try {
        userId = await tokens.verifyMfaChallenge(body.mfaToken);
      } catch {
        throw unauthorized('MFA challenge expired — sign in again');
      }
      const user = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
      if (!user.mfa_enabled || !user.mfa_secret_enc || user.disabled || isLocked(user)) throw invalidCredentials();

      const secret = decryptField(ring, user.mfa_secret_enc, `users:${user.id}:mfa`);
      const counter = verifyTotp(secret, body.code, user.mfa_last_counter === null ? null : Number(user.mfa_last_counter));
      if (counter === null) {
        await registerFailure(user);
        await audit.record({ actorId: user.id, actorRole: user.role, action: 'auth.mfa', resourceType: 'session', outcome: 'denied', ip: req.ip });
        throw new HttpError(401, 'INVALID_MFA_CODE', 'Invalid verification code');
      }
      await db.updateTable('users').set({ mfa_last_counter: counter, failed_logins: 0 }).where('id', '=', user.id).execute();
      await audit.record({ actorId: user.id, actorRole: user.role, action: 'auth.login', resourceType: 'session', ip: req.ip, detail: { amr: ['pwd', 'otp'] } });
      return issueSession(req, reply, user, ['pwd', 'otp'], body.client);
    });

    // Refresh runs on every page load, so it gets a looser limit than credential checks.
    app.post('/refresh', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
      const body = refreshBody.parse(req.body ?? {});
      const fromCookie = req.cookies[REFRESH_COOKIE];
      // Cookie-based refresh requires a custom header, which forces a CORS preflight (CSRF defence).
      if (fromCookie && !body.refreshToken && req.headers['x-requested-with'] !== 'carebridge') {
        throw new HttpError(400, 'CSRF_HEADER_MISSING', 'Missing X-Requested-With header');
      }
      const presented = body.refreshToken ?? fromCookie;
      if (!presented) throw unauthorized('No refresh token');
      const client = body.refreshToken ? 'mobile' : 'web';

      const row = await db.selectFrom('refresh_tokens').selectAll().where('token_hash', '=', sha256(presented)).executeTakeFirst();
      if (!row) throw unauthorized('Invalid refresh token');

      if (row.revoked_at) {
        // A rotated token was replayed → token theft. Kill the whole session family.
        await db.updateTable('refresh_tokens').set({ revoked_at: nowIso() }).where('family_id', '=', row.family_id).where('revoked_at', 'is', null).execute();
        await audit.record({ actorId: row.user_id, actorRole: null, action: 'auth.refresh_reuse_detected', resourceType: 'session', resourceId: row.family_id, outcome: 'denied', ip: req.ip });
        reply.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
        throw unauthorized('Session revoked');
      }
      if (new Date(row.expires_at).getTime() < Date.now()) throw unauthorized('Session expired');

      const user = await db.selectFrom('users').selectAll().where('id', '=', row.user_id).executeTakeFirstOrThrow();
      if (user.disabled) throw unauthorized('Account disabled');

      // Conditional revoke guarantees only one concurrent refresh can win the rotation.
      const res = await db
        .updateTable('refresh_tokens')
        .set({ revoked_at: nowIso() })
        .where('id', '=', row.id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) throw unauthorized('Session revoked');

      return issueSession(req, reply, user, row.amr.split(','), client, row.family_id);
    });

    app.post('/logout', { preHandler: guard(ctx, { allowWithoutMfa: true }) }, async (req, reply) => {
      const u = currentUser(req);
      await db.updateTable('refresh_tokens').set({ revoked_at: nowIso() }).where('family_id', '=', u.sid).where('revoked_at', 'is', null).execute();
      reply.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'auth.logout', resourceType: 'session', resourceId: u.sid, ip: req.ip });
      return { ok: true };
    });

    app.get('/me', { preHandler: guard(ctx, { allowWithoutMfa: true }) }, async (req) => {
      const u = currentUser(req);
      const user = await db.selectFrom('users').selectAll().where('id', '=', u.sub).executeTakeFirstOrThrow();
      return { ...profile(user), amr: u.amr };
    });

    app.post('/mfa/setup', { preHandler: guard(ctx, { allowWithoutMfa: true }) }, async (req) => {
      const u = currentUser(req);
      const user = await db.selectFrom('users').selectAll().where('id', '=', u.sub).executeTakeFirstOrThrow();
      if (user.mfa_enabled) throw conflict('MFA is already enabled');
      const secret = generateTotpSecret();
      await db
        .updateTable('users')
        .set({ mfa_secret_enc: encryptField(ring, secret, `users:${user.id}:mfa`) })
        .where('id', '=', user.id)
        .execute();
      const email = decryptField(ring, user.email_enc, `users:${user.id}:email`);
      const label = encodeURIComponent(`CareBridge:${email}`);
      return { secret, otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=CareBridge&algorithm=SHA1&digits=6&period=30` };
    });

    app.post('/mfa/enable', { preHandler: guard(ctx, { allowWithoutMfa: true }), config: strictLimit }, async (req, reply) => {
      const u = currentUser(req);
      const { code, client } = z.object({ code: z.string().regex(/^\d{6}$/), client: z.enum(['web', 'mobile']).default('web') }).parse(req.body);
      const user = await db.selectFrom('users').selectAll().where('id', '=', u.sub).executeTakeFirstOrThrow();
      if (user.mfa_enabled) throw conflict('MFA is already enabled');
      if (!user.mfa_secret_enc) throw new HttpError(400, 'MFA_NOT_STARTED', 'Call /auth/mfa/setup first');
      const counter = verifyTotp(decryptField(ring, user.mfa_secret_enc, `users:${user.id}:mfa`), code, null);
      if (counter === null) throw new HttpError(401, 'INVALID_MFA_CODE', 'Invalid verification code');
      await db.updateTable('users').set({ mfa_enabled: 1, mfa_last_counter: counter }).where('id', '=', user.id).execute();
      // Revoke the pre-MFA session and issue a fresh, MFA-strength one.
      await db.updateTable('refresh_tokens').set({ revoked_at: nowIso() }).where('family_id', '=', u.sid).where('revoked_at', 'is', null).execute();
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'auth.mfa_enabled', resourceType: 'user', resourceId: u.sub, ip: req.ip });
      return issueSession(req, reply, { ...user, mfa_enabled: 1 }, ['pwd', 'otp'], client);
    });
  };
}
