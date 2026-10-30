
/**
 * Database schema. Columns ending in `_enc` hold AES-256-GCM envelope ciphertext (see lib/crypto.ts);
 * columns ending in `_bidx` hold HMAC blind indexes that allow exact-match lookup without decrypting.
 * Timestamps are ISO-8601 UTC strings so the schema is identical on SQLite and PostgreSQL.
 */
export type Role = 'patient' | 'clinician' | 'biomed_tech' | 'admin';
export const STAFF_ROLES: readonly Role[] = ['clinician', 'biomed_tech', 'admin'];

export interface FacilitiesTable {
  id: string;
  name: string;
  region: string;
  timezone: string;
}

export interface UsersTable {
  id: string;
  email_bidx: string;
  email_enc: string;
  display_name: string;
  password_hash: string;
  role: Role;
  facility_id: string | null;
  patient_id: string | null;
  mfa_secret_enc: string | null;
  mfa_enabled: number;
  mfa_last_counter: number | null;
  failed_logins: number;
  locked_until: string | null;
  disabled: number;
  created_at: string;
}

export interface RefreshTokensTable {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  amr: string;
  expires_at: string;
  revoked_at: string | null;
  replaced_by: string | null;
  created_at: string;
  user_agent: string | null;
}

export interface PatientsTable {
  id: string;
  facility_id: string;
  mrn_bidx: string;
  mrn_enc: string;
  name_enc: string;
  dob_enc: string;
  phone_enc: string | null;
  allergies_enc: string | null;
  created_at: string;
}

export interface VitalsTable {
  id: string;
  patient_id: string;
  kind: 'heart_rate' | 'spo2' | 'bp_systolic' | 'bp_diastolic' | 'temperature' | 'resp_rate';
  value: number;
  unit: string;
  source_device_id: string | null;
  recorded_by: string | null;
  recorded_at: string;
}

export interface ClinicalNotesTable {
  id: string;
  patient_id: string;
  author_id: string;
  body_enc: string;
  created_at: string;
}

export interface AppointmentsTable {
  id: string;
  patient_id: string;
  clinician_id: string;
  facility_id: string;
  starts_at: string;
  duration_min: number;
  reason_enc: string;
  status: 'scheduled' | 'checked_in' | 'completed' | 'cancelled';
  telehealth: number;
  created_at: string;
}

export type DeviceStatus = 'online' | 'degraded' | 'offline' | 'maintenance';

export interface DevicesTable {
  id: string;
  facility_id: string;
  asset_tag: string;
  kind: string;
  manufacturer: string;
  model: string;
  serial: string;
  location: string;
  status: DeviceStatus;
  firmware: string;
  risk_class: 'I' | 'II' | 'III';
  /** Per-device secret (encrypted) used to verify HMAC-signed telemetry. */
  credential_enc: string;
  last_heartbeat_at: string | null;
  last_nonce_ts: number | null;
  next_service_due: string | null;
  battery_pct: number | null;
  assigned_patient_id: string | null;
  created_at: string;
}

export interface TelemetryTable {
  id: string;
  device_id: string;
  metric: string;
  value: number;
  at: string;
}

export interface WorkOrdersTable {
  id: string;
  device_id: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'in_progress' | 'resolved' | 'cancelled';
  assigned_to: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface AlertsTable {
  id: string;
  facility_id: string;
  device_id: string | null;
  patient_id: string | null;
  severity: 'info' | 'warning' | 'critical';
  kind: string;
  message: string;
  created_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
}

export interface AuditLogTable {
  seq: number;
  id: string;
  at: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: 'success' | 'denied' | 'error';
  ip: string | null;
  detail: string | null;
  prev_hash: string;
  hash: string;
}

export interface DB {
  facilities: FacilitiesTable;
  users: UsersTable;
  refresh_tokens: RefreshTokensTable;
  patients: PatientsTable;
  vitals: VitalsTable;
  clinical_notes: ClinicalNotesTable;
  appointments: AppointmentsTable;
  devices: DevicesTable;
  telemetry: TelemetryTable;
  work_orders: WorkOrdersTable;
  alerts: AlertsTable;
  audit_log: AuditLogTable;
}
