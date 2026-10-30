import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { hmacHex, totpAt } from '../src/lib/crypto.js';
import { sweepStaleDevices } from '../src/services/watchdog.js';
import { bearer, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
before(async () => {
  env = await setup();
});
after(() => env.close());

describe('authentication', () => {
  test('rejects unauthenticated requests', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/patients' });
    assert.equal(res.statusCode, 401);
  });

  test('wrong password and unknown user return the same error', async () => {
    const a = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'dr.ali@carebridge.test', password: 'nope' } });
    const b = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'ghost@carebridge.test', password: 'nope' } });
    assert.equal(a.statusCode, 401);
    assert.deepEqual(a.json(), b.json());
  });

  test('web login sets HttpOnly SameSite=Strict refresh cookie and never returns the token in the body', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'dr.chen@carebridge.test', password: 'CareBridge!2026', client: 'web' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().refreshToken, undefined);
    const cookie = String(res.headers['set-cookie']);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  test('refresh token rotation detects reuse and revokes the session family', async () => {
    const login = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'dr.chen@carebridge.test', password: 'CareBridge!2026', client: 'mobile' } });
    const rt1 = login.json().refreshToken as string;
    const r1 = await env.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: rt1 } });
    assert.equal(r1.statusCode, 200);
    const rt2 = r1.json().refreshToken as string;
    // Attacker replays the old token → whole family revoked, including the legitimate rt2.
    const replay = await env.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: rt1 } });
    assert.equal(replay.statusCode, 401);
    const r2 = await env.app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: rt2 } });
    assert.equal(r2.statusCode, 401);
  });

  test('account locks after repeated failures', async () => {
    for (let i = 0; i < 5; i++) {
      await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'dr.ali@carebridge.test', password: 'wrong' } });
    }
    const res = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'dr.ali@carebridge.test', password: 'CareBridge!2026' } });
    assert.equal(res.statusCode, 401, 'correct password must be refused while locked');
    await env.ctx.db.updateTable('users').set({ locked_until: null, failed_logins: 0 }).execute();
  });

  test('MFA enrolment, login with OTP, and staff MFA enforcement', async () => {
    const strict = await setupStrict();
    try {
      const token = await strict.login('tech.lee@carebridge.test');
      const blocked = await strict.app.inject({ method: 'GET', url: '/api/v1/devices', headers: bearer(token) });
      assert.equal(blocked.statusCode, 403);
      assert.equal(blocked.json().error.code, 'MFA_REQUIRED');

      const setupRes = await strict.app.inject({ method: 'POST', url: '/api/v1/auth/mfa/setup', headers: bearer(token) });
      const { secret } = setupRes.json();
      const counter = Math.floor(Date.now() / 30_000);
      const enable = await strict.app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enable', headers: bearer(token), payload: { code: totpAt(secret, counter), client: 'mobile' } });
      assert.equal(enable.statusCode, 200);
      const ok = await strict.app.inject({ method: 'GET', url: '/api/v1/devices', headers: bearer(enable.json().accessToken) });
      assert.equal(ok.statusCode, 200);

      const step1 = await strict.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'tech.lee@carebridge.test', password: 'CareBridge!2026' } });
      assert.equal(step1.json().mfaRequired, true);
      const reused = await strict.app.inject({ method: 'POST', url: '/api/v1/auth/mfa/verify', payload: { mfaToken: step1.json().mfaToken, code: totpAt(secret, counter) } });
      assert.equal(reused.statusCode, 401, 'an already-used OTP must be rejected');
      const step2 = await strict.app.inject({ method: 'POST', url: '/api/v1/auth/mfa/verify', payload: { mfaToken: step1.json().mfaToken, code: totpAt(secret, counter + 1) } });
      assert.equal(step2.statusCode, 200);
    } finally {
      await strict.close();
    }
  });
});

async function setupStrict() {
  return setup({ REQUIRE_STAFF_MFA: true });
}

describe('patient data access control', () => {
  test('PHI is encrypted at rest', async () => {
    const row = await env.ctx.db.selectFrom('patients').selectAll().executeTakeFirstOrThrow();
    assert.ok(row.name_enc.startsWith('v1.'));
    assert.ok(!JSON.stringify(row).includes('Jordan'));
  });

  test('clinician sees own facility only', async () => {
    const t = await env.login('dr.chen@carebridge.test');
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/patients', headers: bearer(t) });
    assert.equal(res.statusCode, 200);
    const list = res.json() as { facilityId: string }[];
    assert.ok(list.length > 0 && list.every((p) => p.facilityId === 'fac-north'));
  });

  test('cross-facility chart access is denied, then allowed via audited break-glass', async () => {
    const t = await env.login('dr.ali@carebridge.test'); // fac-lake
    const target = (await env.ctx.db.selectFrom('patients').select('id').where('facility_id', '=', 'fac-north').executeTakeFirstOrThrow()).id;
    const denied = await env.app.inject({ method: 'GET', url: `/api/v1/patients/${target}`, headers: bearer(t) });
    assert.equal(denied.statusCode, 403);
    const bg = await env.app.inject({ method: 'GET', url: `/api/v1/patients/${target}`, headers: { ...bearer(t), 'x-break-glass-reason': 'Patient arrived unconscious in ER' } });
    assert.equal(bg.statusCode, 200);
    const alert = await env.ctx.db.selectFrom('alerts').selectAll().where('kind', '=', 'break_glass_access').where('patient_id', '=', target).executeTakeFirst();
    assert.ok(alert, 'break-glass must raise a privacy alert');
    const entry = await env.ctx.db.selectFrom('audit_log').selectAll().where('action', '=', 'phi.read').where('resource_id', '=', target).where('actor_id', 'is not', null).orderBy('seq', 'desc').executeTakeFirstOrThrow();
    assert.match(entry.detail ?? '', /breakGlass/);
  });

  test('patient can read only their own record', async () => {
    const t = await env.login('jordan@carebridge.test');
    const me = await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(t) });
    const own = await env.app.inject({ method: 'GET', url: `/api/v1/patients/${me.json().patientId}`, headers: bearer(t) });
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().name, 'Jordan Rivera');
    const other = (await env.ctx.db.selectFrom('patients').select('id').where('id', '!=', me.json().patientId).executeTakeFirstOrThrow()).id;
    const res = await env.app.inject({ method: 'GET', url: `/api/v1/patients/${other}`, headers: bearer(t) });
    assert.equal(res.statusCode, 403);
    const list = await env.app.inject({ method: 'GET', url: '/api/v1/patients', headers: bearer(t) });
    assert.equal(list.statusCode, 403);
  });

  test('clinician can write and read encrypted clinical notes', async () => {
    const t = await env.login('dr.chen@carebridge.test');
    const pid = (await env.ctx.db.selectFrom('patients').select('id').where('facility_id', '=', 'fac-north').executeTakeFirstOrThrow()).id;
    const add = await env.app.inject({ method: 'POST', url: `/api/v1/patients/${pid}/notes`, headers: bearer(t), payload: { body: 'Afebrile overnight.' } });
    assert.equal(add.statusCode, 201);
    const res = await env.app.inject({ method: 'GET', url: `/api/v1/patients/${pid}/notes`, headers: bearer(t) });
    assert.equal(res.statusCode, 200);
    assert.ok((res.json() as { body: string }[]).some((n) => n.body === 'Afebrile overnight.'));
    const raw = await env.ctx.db.selectFrom('clinical_notes').select('body_enc').where('id', '=', add.json().id).executeTakeFirstOrThrow();
    assert.ok(!raw.body_enc.includes('Afebrile'));
  });

  test('patient can view vitals and appointments but not clinical notes', async () => {
    const t = await env.login('jordan@carebridge.test');
    const me = (await env.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: bearer(t) })).json();
    assert.equal((await env.app.inject({ method: 'GET', url: `/api/v1/patients/${me.patientId}/vitals`, headers: bearer(t) })).statusCode, 200);
    assert.equal((await env.app.inject({ method: 'GET', url: '/api/v1/appointments', headers: bearer(t) })).statusCode, 200);
    assert.equal((await env.app.inject({ method: 'GET', url: `/api/v1/patients/${me.patientId}/notes`, headers: bearer(t) })).statusCode, 403);
  });

  test('biomedical technician cannot read PHI', async () => {
    const t = await env.login('tech.lee@carebridge.test');
    const pid = (await env.ctx.db.selectFrom('patients').select('id').where('facility_id', '=', 'fac-north').executeTakeFirstOrThrow()).id;
    const res = await env.app.inject({ method: 'GET', url: `/api/v1/patients/${pid}`, headers: bearer(t) });
    assert.equal(res.statusCode, 403);
  });
});

describe('equipment reliability', () => {
  async function registerDevice() {
    const t = await env.login('tech.lee@carebridge.test');
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/v1/devices',
      headers: bearer(t),
      payload: { facilityId: 'fac-north', assetTag: `TST-${Date.now() % 100000}`, kind: 'Infusion Pump', manufacturer: 'Acme', model: 'X1', serial: 'S1', location: 'Lab', firmware: '1.0', riskClass: 'II' },
    });
    assert.equal(res.statusCode, 201);
    return res.json() as { id: string; deviceSecret: string };
  }

  function signed(id: string, secret: string, body: object, ts = Date.now()) {
    const raw = JSON.stringify(body);
    return {
      method: 'POST' as const,
      url: '/api/v1/ingest/heartbeat',
      headers: { 'content-type': 'application/json', 'x-device-id': id, 'x-device-timestamp': String(ts), 'x-device-signature': hmacHex(secret, `${ts}.${raw}`) },
      payload: raw,
    };
  }

  test('accepts signed heartbeat, rejects bad signature and replay', async () => {
    const d = await registerDevice();
    const req = signed(d.id, d.deviceSecret, { metrics: { battery_pct: 80 } });
    assert.equal((await env.app.inject(req)).statusCode, 200);
    assert.equal((await env.app.inject(req)).statusCode, 409, 'replayed request must be rejected');
    const forged = signed(d.id, 'not-the-secret', { metrics: { battery_pct: 80 } });
    assert.equal((await env.app.inject(forged)).statusCode, 401);
    const stale = signed(d.id, d.deviceSecret, {}, Date.now() - 5 * 60_000);
    assert.equal((await env.app.inject(stale)).statusCode, 401);
  });

  test('threshold breach raises a single de-duplicated alert', async () => {
    const d = await registerDevice();
    await env.app.inject(signed(d.id, d.deviceSecret, { metrics: { battery_pct: 12 } }, Date.now() - 1));
    await env.app.inject(signed(d.id, d.deviceSecret, { metrics: { battery_pct: 11 } }));
    const alerts = await env.ctx.db.selectFrom('alerts').selectAll().where('device_id', '=', d.id).execute();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.kind, 'threshold_battery_pct');
  });

  test('watchdog flags silent devices offline and alerts', async () => {
    const d = await registerDevice();
    await env.app.inject(signed(d.id, d.deviceSecret, {}));
    const flagged = await sweepStaleDevices(env.ctx, Date.now() + 10 * 60_000);
    assert.ok(flagged.includes(d.id));
    const dev = await env.ctx.db.selectFrom('devices').select('status').where('id', '=', d.id).executeTakeFirstOrThrow();
    assert.equal(dev.status, 'offline');
    const alert = await env.ctx.db.selectFrom('alerts').selectAll().where('device_id', '=', d.id).where('kind', '=', 'device_offline').executeTakeFirst();
    assert.ok(alert);
  });

  test('clinician can report a fault but cannot change device configuration', async () => {
    const t = await env.login('dr.chen@carebridge.test');
    const dev = await env.ctx.db.selectFrom('devices').select('id').where('facility_id', '=', 'fac-north').executeTakeFirstOrThrow();
    const wo = await env.app.inject({ method: 'POST', url: '/api/v1/work-orders', headers: bearer(t), payload: { deviceId: dev.id, title: 'Screen flickers', priority: 'medium' } });
    assert.equal(wo.statusCode, 201);
    const patch = await env.app.inject({ method: 'PATCH', url: `/api/v1/devices/${dev.id}`, headers: bearer(t), payload: { status: 'maintenance' } });
    assert.equal(patch.statusCode, 403);
  });

  test('dashboard summary reports fleet availability', async () => {
    const t = await env.login('tech.lee@carebridge.test');
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/dashboard/summary', headers: bearer(t) });
    assert.equal(res.statusCode, 200);
    assert.equal(typeof res.json().fleetAvailabilityPct, 'number');
  });
});

describe('audit trail', () => {
  test('hash chain verifies, and detects tampering', async () => {
    const t = await env.login('admin@carebridge.test');
    const ok = await env.app.inject({ method: 'GET', url: '/api/v1/audit/verify', headers: bearer(t) });
    assert.equal(ok.json().ok, true);
    await env.ctx.db.updateTable('audit_log').set({ action: 'nothing.to.see' }).where('seq', '=', 2).execute();
    const bad = await env.ctx.audit.verify();
    assert.equal(bad.ok, false);
    assert.equal(bad.ok === false && bad.brokenAtSeq, 2);
  });

  test('non-admins cannot read the audit log', async () => {
    const t = await env.login('dr.chen@carebridge.test');
    const res = await env.app.inject({ method: 'GET', url: '/api/v1/audit', headers: bearer(t) });
    assert.equal(res.statusCode, 403);
  });
});

describe('platform', () => {
  test('health probes and security headers', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['strict-transport-security']);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  test('validation errors do not leak internals', async () => {
    const res = await env.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'not-an-email' } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'VALIDATION_FAILED');
  });
});
