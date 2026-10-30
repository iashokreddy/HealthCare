import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { AlertsTable } from '../db/schema.js';

export async function raiseAlert(
  ctx: AppContext,
  a: Pick<AlertsTable, 'facility_id' | 'severity' | 'kind' | 'message'> &
    Partial<Pick<AlertsTable, 'device_id' | 'patient_id'>>,
  opts: { dedupe?: boolean } = { dedupe: true },
) {
  // De-duplicate: don't open a second identical alert while one is still unacknowledged,
  // so a flapping device can't flood clinicians (alarm fatigue is a patient-safety risk).
  if (opts.dedupe !== false) {
    let q = ctx.db
      .selectFrom('alerts')
      .select('id')
      .where('kind', '=', a.kind)
      .where('facility_id', '=', a.facility_id)
      .where('acknowledged_at', 'is', null);
    q = a.device_id ? q.where('device_id', '=', a.device_id) : q.where('device_id', 'is', null);
    q = a.patient_id ? q.where('patient_id', '=', a.patient_id) : q.where('patient_id', 'is', null);
    const existing = await q.executeTakeFirst();
    if (existing) return existing.id;
  }
  const row: AlertsTable = {
    id: randomUUID(),
    facility_id: a.facility_id,
    device_id: a.device_id ?? null,
    patient_id: a.patient_id ?? null,
    severity: a.severity,
    kind: a.kind,
    message: a.message,
    created_at: new Date().toISOString(),
    acknowledged_by: null,
    acknowledged_at: null,
  };
  await ctx.db.insertInto('alerts').values(row).execute();
  ctx.events.publish({
    type: 'alert.created',
    facilityId: row.facility_id,
    alertId: row.id,
    severity: row.severity,
    message: row.message,
    at: row.created_at,
  });
  return row.id;
}

/** Clinical & technical thresholds evaluated on every telemetry sample. */
export const THRESHOLDS: Record<
  string,
  { below?: number; above?: number; severity: AlertsTable['severity']; label: string; patientLinked: boolean }[]
> = {
  spo2: [{ below: 90, severity: 'critical', label: 'SpO₂ below 90%', patientLinked: true }],
  heart_rate: [
    { below: 40, severity: 'critical', label: 'Heart rate below 40 bpm', patientLinked: true },
    { above: 140, severity: 'critical', label: 'Heart rate above 140 bpm', patientLinked: true },
  ],
  battery_pct: [{ below: 20, severity: 'warning', label: 'Device battery below 20%', patientLinked: false }],
  temperature_c: [{ above: 45, severity: 'warning', label: 'Device over-temperature', patientLinked: false }],
  occlusion_pressure: [{ above: 900, severity: 'critical', label: 'Infusion line occlusion detected', patientLinked: true }],
};
