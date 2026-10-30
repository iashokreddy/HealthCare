import { sql } from 'kysely';
import type { Database } from './database.js';

/**
 * Forward-only, idempotent schema migrations written with Kysely's schema builder so the same
 * definitions run on SQLite (dev/test) and PostgreSQL (production). Every migration is designed
 * to be backwards compatible with the previous release (expand → migrate → contract) so rolling
 * deployments never need downtime.
 */
type Migration = { id: string; up: (db: Database) => Promise<void> };

const migrations: Migration[] = [
  {
    id: '0001_initial',
    async up(db) {
      await db.schema
        .createTable('facilities')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('name', 'text', (c) => c.notNull())
        .addColumn('region', 'text', (c) => c.notNull())
        .addColumn('timezone', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('users')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('email_bidx', 'text', (c) => c.notNull().unique())
        .addColumn('email_enc', 'text', (c) => c.notNull())
        .addColumn('display_name', 'text', (c) => c.notNull())
        .addColumn('password_hash', 'text', (c) => c.notNull())
        .addColumn('role', 'text', (c) => c.notNull())
        .addColumn('facility_id', 'text', (c) => c.references('facilities.id'))
        .addColumn('patient_id', 'text')
        .addColumn('mfa_secret_enc', 'text')
        .addColumn('mfa_enabled', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('mfa_last_counter', 'bigint')
        .addColumn('failed_logins', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('locked_until', 'text')
        .addColumn('disabled', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('refresh_tokens')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('family_id', 'text', (c) => c.notNull())
        .addColumn('token_hash', 'text', (c) => c.notNull().unique())
        .addColumn('amr', 'text', (c) => c.notNull())
        .addColumn('expires_at', 'text', (c) => c.notNull())
        .addColumn('revoked_at', 'text')
        .addColumn('replaced_by', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('user_agent', 'text')
        .execute();
      await db.schema.createIndex('refresh_tokens_family').on('refresh_tokens').column('family_id').execute();

      await db.schema
        .createTable('patients')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('facility_id', 'text', (c) => c.notNull().references('facilities.id'))
        .addColumn('mrn_bidx', 'text', (c) => c.notNull().unique())
        .addColumn('mrn_enc', 'text', (c) => c.notNull())
        .addColumn('name_enc', 'text', (c) => c.notNull())
        .addColumn('dob_enc', 'text', (c) => c.notNull())
        .addColumn('phone_enc', 'text')
        .addColumn('allergies_enc', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('vitals')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('patient_id', 'text', (c) => c.notNull().references('patients.id'))
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('value', 'real', (c) => c.notNull())
        .addColumn('unit', 'text', (c) => c.notNull())
        .addColumn('source_device_id', 'text')
        .addColumn('recorded_by', 'text')
        .addColumn('recorded_at', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('vitals_patient_time').on('vitals').columns(['patient_id', 'recorded_at']).execute();

      await db.schema
        .createTable('clinical_notes')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('patient_id', 'text', (c) => c.notNull().references('patients.id'))
        .addColumn('author_id', 'text', (c) => c.notNull().references('users.id'))
        .addColumn('body_enc', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('appointments')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('patient_id', 'text', (c) => c.notNull().references('patients.id'))
        .addColumn('clinician_id', 'text', (c) => c.notNull().references('users.id'))
        .addColumn('facility_id', 'text', (c) => c.notNull().references('facilities.id'))
        .addColumn('starts_at', 'text', (c) => c.notNull())
        .addColumn('duration_min', 'integer', (c) => c.notNull())
        .addColumn('reason_enc', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('telehealth', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('devices')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('facility_id', 'text', (c) => c.notNull().references('facilities.id'))
        .addColumn('asset_tag', 'text', (c) => c.notNull().unique())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('manufacturer', 'text', (c) => c.notNull())
        .addColumn('model', 'text', (c) => c.notNull())
        .addColumn('serial', 'text', (c) => c.notNull())
        .addColumn('location', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('firmware', 'text', (c) => c.notNull())
        .addColumn('risk_class', 'text', (c) => c.notNull())
        .addColumn('credential_enc', 'text', (c) => c.notNull())
        .addColumn('last_heartbeat_at', 'text')
        .addColumn('last_nonce_ts', 'bigint')
        .addColumn('next_service_due', 'text')
        .addColumn('battery_pct', 'real')
        .addColumn('assigned_patient_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('telemetry')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('device_id', 'text', (c) => c.notNull().references('devices.id'))
        .addColumn('metric', 'text', (c) => c.notNull())
        .addColumn('value', 'real', (c) => c.notNull())
        .addColumn('at', 'text', (c) => c.notNull())
        .execute();
      await db.schema.createIndex('telemetry_device_time').on('telemetry').columns(['device_id', 'at']).execute();

      await db.schema
        .createTable('work_orders')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('device_id', 'text', (c) => c.notNull().references('devices.id'))
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('description', 'text', (c) => c.notNull())
        .addColumn('priority', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('assigned_to', 'text', (c) => c.references('users.id'))
        .addColumn('created_by', 'text', (c) => c.notNull().references('users.id'))
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .addColumn('resolved_at', 'text')
        .execute();

      await db.schema
        .createTable('alerts')
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('facility_id', 'text', (c) => c.notNull().references('facilities.id'))
        .addColumn('device_id', 'text')
        .addColumn('patient_id', 'text')
        .addColumn('severity', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('message', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('acknowledged_by', 'text')
        .addColumn('acknowledged_at', 'text')
        .execute();
      await db.schema.createIndex('alerts_open').on('alerts').columns(['facility_id', 'acknowledged_at']).execute();

      await db.schema
        .createTable('audit_log')
        .addColumn('seq', 'bigint', (c) => c.primaryKey())
        .addColumn('id', 'text', (c) => c.notNull().unique())
        .addColumn('at', 'text', (c) => c.notNull())
        .addColumn('actor_id', 'text')
        .addColumn('actor_role', 'text')
        .addColumn('action', 'text', (c) => c.notNull())
        .addColumn('resource_type', 'text', (c) => c.notNull())
        .addColumn('resource_id', 'text')
        .addColumn('outcome', 'text', (c) => c.notNull())
        .addColumn('ip', 'text')
        .addColumn('detail', 'text')
        .addColumn('prev_hash', 'text', (c) => c.notNull())
        .addColumn('hash', 'text', (c) => c.notNull())
        .execute();
    },
  },
];

export async function migrate(db: Database): Promise<string[]> {
  await db.schema
    .createTable('schema_migrations')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('applied_at', 'text', (c) => c.notNull())
    .execute();

  const applied = new Set(
    (await sql<{ id: string }>`select id from schema_migrations`.execute(db)).rows.map((r) => r.id),
  );
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    await db.transaction().execute(async (trx) => {
      await m.up(trx);
      await sql`insert into schema_migrations (id, applied_at) values (${m.id}, ${new Date().toISOString()})`.execute(trx);
    });
    ran.push(m.id);
  }
  return ran;
}
