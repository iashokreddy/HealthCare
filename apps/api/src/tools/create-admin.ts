/**
 * Bootstraps the first administrator in an empty environment (production never auto-seeds).
 *
 *   node dist/tools/create-admin.js admin@hospital.org "Full Name"
 *
 * A strong random password is generated and printed once; the admin must enrol MFA on first login.
 */
import { randomUUID } from 'node:crypto';
import { buildContext } from '../app.js';
import { blindIndex, encryptField, hashPassword, randomToken } from '../lib/crypto.js';

const [email, displayName = 'Administrator'] = process.argv.slice(2);
if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
  console.error('usage: create-admin <email> [display name]');
  process.exit(1);
}

const ctx = await buildContext();
const bidx = blindIndex(ctx.ring, email, 'email');
if (await ctx.db.selectFrom('users').select('id').where('email_bidx', '=', bidx).executeTakeFirst()) {
  console.error('A user with that email already exists.');
  process.exit(1);
}
const password = randomToken(18);
const id = randomUUID();
await ctx.db
  .insertInto('users')
  .values({
    id,
    email_bidx: bidx,
    email_enc: encryptField(ctx.ring, email.toLowerCase(), `users:${id}:email`),
    display_name: displayName,
    password_hash: await hashPassword(password),
    role: 'admin',
    facility_id: null,
    patient_id: null,
    mfa_secret_enc: null,
    mfa_enabled: 0,
    mfa_last_counter: null,
    failed_logins: 0,
    locked_until: null,
    disabled: 0,
    created_at: new Date().toISOString(),
  })
  .execute();
await ctx.audit.record({ actorId: null, actorRole: 'system', action: 'user.bootstrap_admin', resourceType: 'user', resourceId: id });
await ctx.db.destroy();
console.log(`Created admin ${email}\nTemporary password (shown once): ${password}`);
