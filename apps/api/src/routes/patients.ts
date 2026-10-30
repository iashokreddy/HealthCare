import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { PatientsTable } from '../db/schema.js';
import { assertFacilityAccess, assertPatientAccess, currentUser, guard } from '../lib/auth.js';
import { blindIndex, decryptField, encryptField } from '../lib/crypto.js';
import { conflict, forbidden, notFound, nowIso } from '../lib/http.js';
import { raiseAlert } from '../services/alerts.js';

const VITAL_KINDS = ['heart_rate', 'spo2', 'bp_systolic', 'bp_diastolic', 'temperature', 'resp_rate'] as const;
const VITAL_UNITS: Record<(typeof VITAL_KINDS)[number], string> = {
  heart_rate: 'bpm',
  spo2: '%',
  bp_systolic: 'mmHg',
  bp_diastolic: 'mmHg',
  temperature: '°C',
  resp_rate: 'br/min',
};

const createPatientBody = z.object({
  facilityId: z.string().min(1),
  mrn: z.string().regex(/^[A-Z0-9-]{4,20}$/i),
  name: z.string().min(1).max(200),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  phone: z.string().max(40).optional(),
  allergies: z.string().max(2000).optional(),
});

export function decryptPatient(ctx: AppContext, p: PatientsTable) {
  const d = (v: string | null, f: string) => (v ? decryptField(ctx.ring, v, `patients:${p.id}:${f}`) : null);
  return {
    id: p.id,
    facilityId: p.facility_id,
    mrn: d(p.mrn_enc, 'mrn')!,
    name: d(p.name_enc, 'name')!,
    dob: d(p.dob_enc, 'dob')!,
    phone: d(p.phone_enc, 'phone'),
    allergies: d(p.allergies_enc, 'allergies'),
    createdAt: p.created_at,
  };
}

export function patientRoutes(ctx: AppContext) {
  const { db, ring, audit } = ctx;

  async function loadPatient(req: FastifyRequest, id: string) {
    const p = await db.selectFrom('patients').selectAll().where('id', '=', id).executeTakeFirst();
    if (!p) throw notFound('Patient');
    try {
      assertPatientAccess(req, p);
    } catch (err) {
      const u = currentUser(req);
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'phi.read', resourceType: 'patient', resourceId: id, outcome: 'denied', ip: req.ip });
      throw err;
    }
    return p;
  }

  async function recordPhiAccess(req: FastifyRequest, action: string, p: PatientsTable) {
    const u = currentUser(req);
    await audit.record({
      actorId: u.sub,
      actorRole: u.role,
      action,
      resourceType: 'patient',
      resourceId: p.id,
      ip: req.ip,
      detail: req.breakGlassReason ? { breakGlass: true, reason: req.breakGlassReason } : undefined,
    });
    if (req.breakGlassReason) {
      // Emergency access outside the clinician's facility is allowed but immediately surfaced
      // to the privacy office for retrospective review.
      await raiseAlert(ctx, {
        facility_id: p.facility_id,
        severity: 'warning',
        kind: 'break_glass_access',
        message: `Break-glass access to a patient record by user ${u.sub}`,
        patient_id: p.id,
      }, { dedupe: false });
    }
  }

  return async function register(app: FastifyInstance) {
    const staff = guard(ctx, { roles: ['clinician', 'admin'] });
    const anyUser = guard(ctx);

    app.get('/', { preHandler: staff }, async (req) => {
      const u = currentUser(req);
      const q = z.object({ mrn: z.string().max(20).optional(), facilityId: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
      const facilityId = u.role === 'admin' ? q.facilityId : u.fid!;
      let query = db.selectFrom('patients').selectAll().limit(q.limit).orderBy('created_at', 'desc');
      if (facilityId) query = query.where('facility_id', '=', facilityId);
      if (q.mrn) query = query.where('mrn_bidx', '=', blindIndex(ring, q.mrn, 'mrn'));
      const rows = await query.execute();
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'phi.list', resourceType: 'patient', ip: req.ip, detail: { count: rows.length, mrnSearch: !!q.mrn } });
      return rows.map((p) => {
        const d = decryptPatient(ctx, p);
        return { id: d.id, facilityId: d.facilityId, mrn: d.mrn, name: d.name, dob: d.dob };
      });
    });

    app.post('/', { preHandler: staff }, async (req, reply) => {
      const u = currentUser(req);
      const body = createPatientBody.parse(req.body);
      assertFacilityAccess(req, body.facilityId);
      const mrnBidx = blindIndex(ring, body.mrn, 'mrn');
      if (await db.selectFrom('patients').select('id').where('mrn_bidx', '=', mrnBidx).executeTakeFirst()) throw conflict('MRN already exists');
      const id = randomUUID();
      const e = (v: string, f: string) => encryptField(ring, v, `patients:${id}:${f}`);
      await db
        .insertInto('patients')
        .values({
          id,
          facility_id: body.facilityId,
          mrn_bidx: mrnBidx,
          mrn_enc: e(body.mrn.toUpperCase(), 'mrn'),
          name_enc: e(body.name, 'name'),
          dob_enc: e(body.dob, 'dob'),
          phone_enc: body.phone ? e(body.phone, 'phone') : null,
          allergies_enc: body.allergies ? e(body.allergies, 'allergies') : null,
          created_at: nowIso(),
        })
        .execute();
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'phi.create', resourceType: 'patient', resourceId: id, ip: req.ip });
      reply.code(201);
      return { id };
    });

    app.get('/:id', { preHandler: anyUser }, async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const p = await loadPatient(req, id);
      await recordPhiAccess(req, 'phi.read', p);
      const latest = await db
        .selectFrom('vitals')
        .select(['kind', 'value', 'unit', 'recorded_at'])
        .where('patient_id', '=', id)
        .orderBy('recorded_at', 'desc')
        .limit(60)
        .execute();
      const latestByKind: Record<string, { value: number; unit: string; recordedAt: string }> = {};
      for (const v of latest) latestByKind[v.kind] ??= { value: v.value, unit: v.unit, recordedAt: v.recorded_at };
      const devices = await db
        .selectFrom('devices')
        .select(['id', 'asset_tag', 'kind', 'status', 'location'])
        .where('assigned_patient_id', '=', id)
        .execute();
      return { ...decryptPatient(ctx, p), latestVitals: latestByKind, devices };
    });

    app.get('/:id/vitals', { preHandler: anyUser }, async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const q = z.object({ kind: z.enum(VITAL_KINDS).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
      const p = await loadPatient(req, id);
      await recordPhiAccess(req, 'phi.read_vitals', p);
      let query = db.selectFrom('vitals').selectAll().where('patient_id', '=', id).orderBy('recorded_at', 'desc').limit(q.limit);
      if (q.kind) query = query.where('kind', '=', q.kind);
      const rows = await query.execute();
      return rows.map((v) => ({ id: v.id, kind: v.kind, value: v.value, unit: v.unit, recordedAt: v.recorded_at, sourceDeviceId: v.source_device_id }));
    });

    app.post('/:id/vitals', { preHandler: guard(ctx, { roles: ['clinician'] }) }, async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = z.object({ kind: z.enum(VITAL_KINDS), value: z.number().finite().min(0).max(400) }).parse(req.body);
      const p = await loadPatient(req, id);
      const u = currentUser(req);
      const vid = randomUUID();
      await db
        .insertInto('vitals')
        .values({ id: vid, patient_id: id, kind: body.kind, value: body.value, unit: VITAL_UNITS[body.kind], source_device_id: null, recorded_by: u.sub, recorded_at: nowIso() })
        .execute();
      await recordPhiAccess(req, 'phi.write_vitals', p);
      reply.code(201);
      return { id: vid };
    });

    app.get('/:id/notes', { preHandler: staff }, async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const p = await loadPatient(req, id);
      await recordPhiAccess(req, 'phi.read_notes', p);
      const rows = await db
        .selectFrom('clinical_notes')
        .innerJoin('users', 'users.id', 'clinical_notes.author_id')
        .select(['clinical_notes.id', 'clinical_notes.body_enc', 'clinical_notes.created_at', 'users.display_name'])
        .where('clinical_notes.patient_id', '=', id)
        .orderBy('clinical_notes.created_at', 'desc')
        .limit(100)
        .execute();
      return rows.map((n) => ({ id: n.id, author: n.display_name, createdAt: n.created_at, body: decryptField(ring, n.body_enc, `notes:${n.id}:body`) }));
    });

    app.post('/:id/notes', { preHandler: guard(ctx, { roles: ['clinician'] }) }, async (req, reply) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const { body } = z.object({ body: z.string().min(1).max(20_000) }).parse(req.body);
      const p = await loadPatient(req, id);
      const u = currentUser(req);
      if (u.role !== 'clinician') throw forbidden();
      const nid = randomUUID();
      await db.insertInto('clinical_notes').values({ id: nid, patient_id: id, author_id: u.sub, body_enc: encryptField(ring, body, `notes:${nid}:body`), created_at: nowIso() }).execute();
      await recordPhiAccess(req, 'phi.write_note', p);
      reply.code(201);
      return { id: nid };
    });
  };
}
