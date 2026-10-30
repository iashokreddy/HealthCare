import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { assertFacilityAccess, assertPatientAccess, currentUser, guard } from '../lib/auth.js';
import { decryptField, encryptField } from '../lib/crypto.js';
import { forbidden, HttpError, notFound, nowIso } from '../lib/http.js';

const createBody = z.object({
  patientId: z.string().min(1),
  clinicianId: z.string().min(1),
  startsAt: z.string().datetime(),
  durationMin: z.number().int().min(5).max(480).default(30),
  reason: z.string().min(1).max(1000),
  telehealth: z.boolean().default(false),
});

export function appointmentRoutes(ctx: AppContext) {
  const { db, ring, audit } = ctx;

  return async function register(app: FastifyInstance) {
    app.get('/', { preHandler: guard(ctx, { roles: ['patient', 'clinician', 'admin'] }) }, async (req) => {
      const u = currentUser(req);
      const q = z.object({ from: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
      let query = db
        .selectFrom('appointments')
        .innerJoin('users as c', 'c.id', 'appointments.clinician_id')
        .innerJoin('patients as p', 'p.id', 'appointments.patient_id')
        .innerJoin('facilities as f', 'f.id', 'appointments.facility_id')
        .select([
          'appointments.id', 'appointments.patient_id', 'appointments.starts_at', 'appointments.duration_min',
          'appointments.reason_enc', 'appointments.status', 'appointments.telehealth',
          'c.display_name as clinician_name', 'p.name_enc', 'f.name as facility_name',
        ])
        .orderBy('appointments.starts_at', 'asc')
        .limit(q.limit);
      if (u.role === 'patient') query = query.where('appointments.patient_id', '=', u.pid ?? '__none__');
      else if (u.role === 'clinician') query = query.where('appointments.clinician_id', '=', u.sub);
      if (q.from) query = query.where('appointments.starts_at', '>=', q.from);
      const rows = await query.execute();
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'phi.list_appointments', resourceType: 'appointment', ip: req.ip, detail: { count: rows.length } });
      return rows.map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        patientName: decryptField(ring, r.name_enc, `patients:${r.patient_id}:name`),
        clinicianName: r.clinician_name,
        facilityName: r.facility_name,
        startsAt: r.starts_at,
        durationMin: r.duration_min,
        reason: decryptField(ring, r.reason_enc, `appointments:${r.id}:reason`),
        status: r.status,
        telehealth: r.telehealth === 1,
      }));
    });

    app.post('/', { preHandler: guard(ctx, { roles: ['patient', 'clinician', 'admin'] }) }, async (req, reply) => {
      const u = currentUser(req);
      const b = createBody.parse(req.body);
      const patient = await db.selectFrom('patients').select(['id', 'facility_id']).where('id', '=', b.patientId).executeTakeFirst();
      if (!patient) throw notFound('Patient');
      assertPatientAccess(req, patient);
      const clinician = await db.selectFrom('users').select(['id', 'role', 'facility_id']).where('id', '=', b.clinicianId).executeTakeFirst();
      if (!clinician || clinician.role !== 'clinician' || !clinician.facility_id) throw notFound('Clinician');
      if (new Date(b.startsAt).getTime() < Date.now()) throw new HttpError(400, 'IN_PAST', 'Appointment must be in the future');
      const id = randomUUID();
      await db
        .insertInto('appointments')
        .values({
          id,
          patient_id: b.patientId,
          clinician_id: b.clinicianId,
          facility_id: clinician.facility_id,
          starts_at: new Date(b.startsAt).toISOString(),
          duration_min: b.durationMin,
          reason_enc: encryptField(ring, b.reason, `appointments:${id}:reason`),
          status: 'scheduled',
          telehealth: b.telehealth ? 1 : 0,
          created_at: nowIso(),
        })
        .execute();
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'appointment.create', resourceType: 'appointment', resourceId: id, ip: req.ip });
      reply.code(201);
      return { id };
    });

    app.patch('/:id', { preHandler: guard(ctx, { roles: ['patient', 'clinician', 'admin'] }) }, async (req) => {
      const u = currentUser(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { status } = z.object({ status: z.enum(['checked_in', 'completed', 'cancelled']) }).parse(req.body);
      const a = await db.selectFrom('appointments').selectAll().where('id', '=', id).executeTakeFirst();
      if (!a) throw notFound('Appointment');
      if (u.role === 'patient') {
        // Patients may only cancel or check in to their own appointments.
        if (u.pid !== a.patient_id || status === 'completed') throw forbidden();
      } else {
        assertFacilityAccess(req, a.facility_id);
      }
      await db.updateTable('appointments').set({ status }).where('id', '=', id).execute();
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'appointment.update', resourceType: 'appointment', resourceId: id, ip: req.ip, detail: { status } });
      return { id, status };
    });
  };
}
