import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { AppContext } from '../context.js';
import { blindIndex, encryptField, hashPassword, randomToken } from '../lib/crypto.js';
import type { Role } from './schema.js';

/**
 * Development seed data. Entirely synthetic — never load real PHI into non-production environments.
 * Demo password for every account: `CareBridge!2026`
 */
export const DEMO_PASSWORD = 'CareBridge!2026';

export async function seedIfEmpty(ctx: AppContext): Promise<string | null> {
  const existing = await ctx.db.selectFrom('users').select('id').limit(1).executeTakeFirst();
  if (existing) return null;
  return seed(ctx);
}

export async function seed(ctx: AppContext): Promise<string> {
  const { db, ring } = ctx;
  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const day = (n: number) => new Date(now.getTime() + n * 86_400_000);

  const facilities = [
    { id: 'fac-north', name: 'Northside General Hospital', region: 'North', timezone: 'America/Chicago' },
    { id: 'fac-lake', name: 'Lakeview Medical Center', region: 'Central', timezone: 'America/Chicago' },
  ];
  await db.insertInto('facilities').values(facilities).execute();

  const patients = [
    { mrn: 'MRN-100234', name: 'Jordan Rivera', dob: '1958-03-14', phone: '555-0101', allergies: 'Penicillin', fac: 'fac-north' },
    { mrn: 'MRN-100871', name: 'Sam Okafor', dob: '1972-11-02', phone: '555-0102', allergies: null, fac: 'fac-north' },
    { mrn: 'MRN-101422', name: 'Taylor Nguyen', dob: '1990-06-21', phone: '555-0103', allergies: 'Latex', fac: 'fac-north' },
    { mrn: 'MRN-200915', name: 'Casey Patel', dob: '1965-01-30', phone: '555-0104', allergies: null, fac: 'fac-lake' },
  ];
  const patientIds: string[] = [];
  for (const p of patients) {
    const id = randomUUID();
    patientIds.push(id);
    const e = (v: string, f: string) => encryptField(ring, v, `patients:${id}:${f}`);
    await db
      .insertInto('patients')
      .values({
        id,
        facility_id: p.fac,
        mrn_bidx: blindIndex(ring, p.mrn, 'mrn'),
        mrn_enc: e(p.mrn, 'mrn'),
        name_enc: e(p.name, 'name'),
        dob_enc: e(p.dob, 'dob'),
        phone_enc: e(p.phone, 'phone'),
        allergies_enc: p.allergies ? e(p.allergies, 'allergies') : null,
        created_at: iso(now),
      })
      .execute();
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const users: { email: string; name: string; role: Role; fac: string | null; pid: string | null }[] = [
    { email: 'admin@carebridge.test', name: 'Avery Admin', role: 'admin', fac: null, pid: null },
    { email: 'dr.chen@carebridge.test', name: 'Dr. Morgan Chen', role: 'clinician', fac: 'fac-north', pid: null },
    { email: 'dr.ali@carebridge.test', name: 'Dr. Reese Ali', role: 'clinician', fac: 'fac-lake', pid: null },
    { email: 'tech.lee@carebridge.test', name: 'Quinn Lee (Biomed)', role: 'biomed_tech', fac: 'fac-north', pid: null },
    { email: 'jordan@carebridge.test', name: 'Jordan Rivera', role: 'patient', fac: null, pid: patientIds[0]! },
  ];
  const userIds: Record<string, string> = {};
  for (const u of users) {
    const id = randomUUID();
    userIds[u.email] = id;
    await db
      .insertInto('users')
      .values({
        id,
        email_bidx: blindIndex(ring, u.email, 'email'),
        email_enc: encryptField(ring, u.email, `users:${id}:email`),
        display_name: u.name,
        password_hash: passwordHash,
        role: u.role,
        facility_id: u.fac,
        patient_id: u.pid,
        mfa_secret_enc: null,
        mfa_enabled: 0,
        mfa_last_counter: null,
        failed_logins: 0,
        locked_until: null,
        disabled: 0,
        created_at: iso(now),
      })
      .execute();
  }

  const devices = [
    { tag: 'INF-0101', kind: 'Infusion Pump', mfr: 'Medline Systems', model: 'FlowSafe 300', loc: 'ICU Bed 4', risk: 'III', fac: 'fac-north', status: 'online', pid: patientIds[0], due: 30 },
    { tag: 'MON-0207', kind: 'Patient Monitor', mfr: 'VitalScope', model: 'VS-12', loc: 'ICU Bed 4', risk: 'II', fac: 'fac-north', status: 'online', pid: patientIds[0], due: 90 },
    { tag: 'VEN-0012', kind: 'Ventilator', mfr: 'AeroCare', model: 'AC-900', loc: 'ICU Bed 7', risk: 'III', fac: 'fac-north', status: 'degraded', pid: patientIds[1], due: 6 },
    { tag: 'DEF-0033', kind: 'Defibrillator', mfr: 'CardioLife', model: 'CL-AED Pro', loc: 'ER Bay 2', risk: 'III', fac: 'fac-north', status: 'online', pid: null, due: 12 },
    { tag: 'MON-0311', kind: 'Patient Monitor', mfr: 'VitalScope', model: 'VS-12', loc: 'Ward 3 Bed 1', risk: 'II', fac: 'fac-north', status: 'maintenance', pid: null, due: -2 },
    { tag: 'INF-0450', kind: 'Infusion Pump', mfr: 'Medline Systems', model: 'FlowSafe 300', loc: 'Oncology 2', risk: 'III', fac: 'fac-lake', status: 'online', pid: patientIds[3], due: 45 },
  ] as const;
  const deviceIds: string[] = [];
  for (const d of devices) {
    const id = randomUUID();
    deviceIds.push(id);
    await db
      .insertInto('devices')
      .values({
        id,
        facility_id: d.fac,
        asset_tag: d.tag,
        kind: d.kind,
        manufacturer: d.mfr,
        model: d.model,
        serial: `SN-${d.tag.replace('-', '')}-${randomToken(3).toUpperCase()}`,
        location: d.loc,
        status: d.status,
        firmware: '4.2.1',
        risk_class: d.risk,
        credential_enc: encryptField(ring, randomToken(32), `devices:${id}:credential`),
        // Recent heartbeat so the watchdog doesn't flag freshly seeded devices immediately.
        last_heartbeat_at: d.status === 'maintenance' ? null : iso(now),
        last_nonce_ts: null,
        next_service_due: day(d.due).toISOString().slice(0, 10),
        battery_pct: d.kind === 'Infusion Pump' ? 76 : null,
        assigned_patient_id: d.pid ?? null,
        created_at: iso(now),
      })
      .execute();
  }

  // 12 hours of synthetic vitals for the first patient.
  const vitals = [];
  for (let i = 0; i < 48; i++) {
    const at = iso(new Date(now.getTime() - (48 - i) * 15 * 60_000));
    vitals.push(
      { id: randomUUID(), patient_id: patientIds[0]!, kind: 'heart_rate' as const, value: 72 + Math.round(Math.sin(i / 4) * 8), unit: 'bpm', source_device_id: deviceIds[1]!, recorded_by: null, recorded_at: at },
      { id: randomUUID(), patient_id: patientIds[0]!, kind: 'spo2' as const, value: 97 + Math.round(Math.sin(i / 6)), unit: '%', source_device_id: deviceIds[1]!, recorded_by: null, recorded_at: at },
    );
  }
  await db.insertInto('vitals').values(vitals).execute();

  const noteId = randomUUID();
  await db
    .insertInto('clinical_notes')
    .values({
      id: noteId,
      patient_id: patientIds[0]!,
      author_id: userIds['dr.chen@carebridge.test']!,
      body_enc: encryptField(ring, 'Post-op day 2. Vitals stable, pain controlled. Continue current infusion rate.', `notes:${noteId}:body`),
      created_at: iso(now),
    })
    .execute();

  const apptId = randomUUID();
  await db
    .insertInto('appointments')
    .values({
      id: apptId,
      patient_id: patientIds[0]!,
      clinician_id: userIds['dr.chen@carebridge.test']!,
      facility_id: 'fac-north',
      starts_at: iso(day(3)),
      duration_min: 30,
      reason_enc: encryptField(ring, 'Post-discharge follow-up', `appointments:${apptId}:reason`),
      status: 'scheduled',
      telehealth: 1,
      created_at: iso(now),
    })
    .execute();

  await db
    .insertInto('work_orders')
    .values({
      id: randomUUID(),
      device_id: deviceIds[2]!,
      title: 'Intermittent pressure sensor fault',
      description: 'Ventilator reports degraded status; sensor readings drift after ~4h of operation.',
      priority: 'high',
      status: 'open',
      assigned_to: userIds['tech.lee@carebridge.test']!,
      created_by: userIds['dr.chen@carebridge.test']!,
      created_at: iso(now),
      updated_at: iso(now),
      resolved_at: null,
    })
    .execute();

  await ctx.audit.record({ actorId: null, actorRole: 'system', action: 'system.seed', resourceType: 'database' });

  return [
    'Seeded demo data (synthetic only). Accounts — password for all: ' + DEMO_PASSWORD,
    ...users.map((u) => `  ${u.role.padEnd(12)} ${u.email}`),
  ].join('\n');
}

// `npm run seed` entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { buildContext } = await import('../app.js');
  const ctx = await buildContext();
  console.log((await seedIfEmpty(ctx)) ?? 'Database already contains data — skipping seed.');
  await ctx.db.destroy();
}
