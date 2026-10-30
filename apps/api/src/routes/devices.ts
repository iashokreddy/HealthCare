import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { DevicesTable } from '../db/schema.js';
import { assertFacilityAccess, currentUser, guard } from '../lib/auth.js';
import { decryptField, encryptField, hmacHex, randomToken, safeEqualHex } from '../lib/crypto.js';
import { conflict, HttpError, notFound, nowIso, unauthorized } from '../lib/http.js';
import { raiseAlert, THRESHOLDS } from '../services/alerts.js';

/** Allowed clock skew for signed device requests; anything older is treated as a replay. */
const SIGNATURE_WINDOW_MS = 60_000;

export function publicDevice(d: DevicesTable) {
  return {
    id: d.id,
    facilityId: d.facility_id,
    assetTag: d.asset_tag,
    kind: d.kind,
    manufacturer: d.manufacturer,
    model: d.model,
    serial: d.serial,
    location: d.location,
    status: d.status,
    firmware: d.firmware,
    riskClass: d.risk_class,
    lastHeartbeatAt: d.last_heartbeat_at,
    nextServiceDue: d.next_service_due,
    batteryPct: d.battery_pct,
    assignedPatientId: d.assigned_patient_id,
  };
}

const createDeviceBody = z.object({
  facilityId: z.string().min(1),
  assetTag: z.string().regex(/^[A-Z0-9-]{3,32}$/i),
  kind: z.string().min(1).max(80),
  manufacturer: z.string().min(1).max(120),
  model: z.string().min(1).max(120),
  serial: z.string().min(1).max(120),
  location: z.string().min(1).max(120),
  firmware: z.string().min(1).max(40),
  riskClass: z.enum(['I', 'II', 'III']),
  nextServiceDue: z.string().date().optional(),
});

const patchDeviceBody = z
  .object({
    status: z.enum(['online', 'maintenance', 'offline']).optional(),
    location: z.string().min(1).max(120).optional(),
    nextServiceDue: z.string().date().nullable().optional(),
    assignedPatientId: z.string().nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'No changes supplied');

const heartbeatBody = z.object({
  status: z.enum(['online', 'degraded']).default('online'),
  firmware: z.string().max(40).optional(),
  metrics: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.number().finite()).refine((m) => Object.keys(m).length <= 32, 'Too many metrics').default({}),
});

const workOrderBody = z.object({
  deviceId: z.string().min(1),
  title: z.string().min(3).max(200),
  description: z.string().max(5000).default(''),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
});

const patchWorkOrderBody = z
  .object({
    status: z.enum(['open', 'in_progress', 'resolved', 'cancelled']).optional(),
    assignedTo: z.string().nullable().optional(),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'No changes supplied');

export function deviceRoutes(ctx: AppContext) {
  const { db, ring, audit, events } = ctx;
  const staff = guard(ctx, { roles: ['clinician', 'biomed_tech', 'admin'] });
  const techOrAdmin = guard(ctx, { roles: ['biomed_tech', 'admin'] });

  async function loadDevice(req: FastifyRequest, id: string) {
    const d = await db.selectFrom('devices').selectAll().where('id', '=', id).executeTakeFirst();
    if (!d) throw notFound('Device');
    assertFacilityAccess(req, d.facility_id);
    return d;
  }

  return async function register(app: FastifyInstance) {
    app.get('/', { preHandler: staff }, async (req) => {
      const u = currentUser(req);
      const q = z.object({ status: z.enum(['online', 'degraded', 'offline', 'maintenance']).optional(), facilityId: z.string().optional() }).parse(req.query);
      let query = db.selectFrom('devices').selectAll().orderBy('asset_tag');
      const fid = u.role === 'admin' ? q.facilityId : u.fid!;
      if (fid) query = query.where('facility_id', '=', fid);
      if (q.status) query = query.where('status', '=', q.status);
      return (await query.execute()).map(publicDevice);
    });

    app.post('/', { preHandler: techOrAdmin }, async (req, reply) => {
      const u = currentUser(req);
      const b = createDeviceBody.parse(req.body);
      assertFacilityAccess(req, b.facilityId);
      if (await db.selectFrom('devices').select('id').where('asset_tag', '=', b.assetTag).executeTakeFirst()) throw conflict('Asset tag already registered');
      const id = randomUUID();
      const secret = randomToken(32);
      await db
        .insertInto('devices')
        .values({
          id,
          facility_id: b.facilityId,
          asset_tag: b.assetTag.toUpperCase(),
          kind: b.kind,
          manufacturer: b.manufacturer,
          model: b.model,
          serial: b.serial,
          location: b.location,
          status: 'offline',
          firmware: b.firmware,
          risk_class: b.riskClass,
          credential_enc: encryptField(ring, secret, `devices:${id}:credential`),
          last_heartbeat_at: null,
          last_nonce_ts: null,
          next_service_due: b.nextServiceDue ?? null,
          battery_pct: null,
          assigned_patient_id: null,
          created_at: nowIso(),
        })
        .execute();
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'device.register', resourceType: 'device', resourceId: id, ip: req.ip });
      reply.code(201);
      // The device secret is shown exactly once — it is provisioned onto the device and never retrievable again.
      return { id, deviceSecret: secret };
    });

    app.get('/:id', { preHandler: staff }, async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const d = await loadDevice(req, id);
      const workOrders = await db.selectFrom('work_orders').selectAll().where('device_id', '=', id).orderBy('created_at', 'desc').limit(20).execute();
      return { ...publicDevice(d), workOrders: workOrders.map(publicWorkOrder) };
    });

    app.patch('/:id', { preHandler: techOrAdmin }, async (req) => {
      const u = currentUser(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const b = patchDeviceBody.parse(req.body);
      const d = await loadDevice(req, id);
      const patch: Partial<DevicesTable> = {};
      if (b.status) patch.status = b.status;
      if (b.location) patch.location = b.location;
      if (b.nextServiceDue !== undefined) patch.next_service_due = b.nextServiceDue;
      if (b.assignedPatientId !== undefined) patch.assigned_patient_id = b.assignedPatientId;
      await db.updateTable('devices').set(patch).where('id', '=', id).execute();
      if (b.status && b.status !== d.status) {
        events.publish({ type: 'device.status', facilityId: d.facility_id, deviceId: id, status: b.status, at: nowIso() });
      }
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'device.update', resourceType: 'device', resourceId: id, ip: req.ip, detail: { fields: Object.keys(b) } });
      return publicDevice({ ...d, ...patch });
    });

    app.post('/:id/rotate-credential', { preHandler: techOrAdmin }, async (req) => {
      const u = currentUser(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);
      await loadDevice(req, id);
      const secret = randomToken(32);
      await db.updateTable('devices').set({ credential_enc: encryptField(ring, secret, `devices:${id}:credential`), last_nonce_ts: null }).where('id', '=', id).execute();
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'device.rotate_credential', resourceType: 'device', resourceId: id, ip: req.ip });
      return { id, deviceSecret: secret };
    });

    app.get('/:id/telemetry', { preHandler: staff }, async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const q = z.object({ metric: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(2000).default(300) }).parse(req.query);
      await loadDevice(req, id);
      let query = db.selectFrom('telemetry').select(['metric', 'value', 'at']).where('device_id', '=', id).orderBy('at', 'desc').limit(q.limit);
      if (q.metric) query = query.where('metric', '=', q.metric);
      return (await query.execute()).reverse();
    });
  };
}

/**
 * Device telemetry ingest. Devices authenticate every request with an HMAC-SHA256 signature over
 * `<timestamp>.<raw body>` using their per-device secret. Timestamps must be fresh and strictly
 * increasing, so captured requests cannot be replayed. (Production adds mutual TLS with
 * per-device X.509 certificates at the gateway, on an isolated medical-device network segment.)
 */
export function ingestRoutes(ctx: AppContext) {
  const { db, ring, events } = ctx;
  return async function register(app: FastifyInstance) {
    app.post('/heartbeat', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
      const deviceId = req.headers['x-device-id'];
      const tsHeader = req.headers['x-device-timestamp'];
      const sig = req.headers['x-device-signature'];
      if (typeof deviceId !== 'string' || typeof tsHeader !== 'string' || typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) {
        throw unauthorized('Missing device signature');
      }
      const ts = Number(tsHeader);
      if (!Number.isSafeInteger(ts) || Math.abs(Date.now() - ts) > SIGNATURE_WINDOW_MS) throw unauthorized('Stale or invalid timestamp');

      const d = await db.selectFrom('devices').selectAll().where('id', '=', deviceId).executeTakeFirst();
      if (!d) throw unauthorized('Unknown device');
      const secret = decryptField(ring, d.credential_enc, `devices:${d.id}:credential`);
      const expected = hmacHex(secret, `${tsHeader}.${req.rawBody ?? ''}`);
      if (!safeEqualHex(expected, sig)) throw unauthorized('Bad signature');
      if (d.last_nonce_ts !== null && ts <= Number(d.last_nonce_ts)) throw new HttpError(409, 'REPLAY', 'Replayed request');

      const body = heartbeatBody.parse(req.body ?? {});
      const at = nowIso();
      // Devices under maintenance keep that status until a technician releases them.
      const status = d.status === 'maintenance' ? 'maintenance' : body.status;

      const claimed = await db
        .updateTable('devices')
        .set({
          last_heartbeat_at: at,
          last_nonce_ts: ts,
          status,
          firmware: body.firmware ?? d.firmware,
          battery_pct: body.metrics.battery_pct ?? d.battery_pct,
        })
        .where('id', '=', d.id)
        .where((eb) => (d.last_nonce_ts === null ? eb('last_nonce_ts', 'is', null) : eb('last_nonce_ts', '<', ts)))
        .executeTakeFirst();
      if (Number(claimed.numUpdatedRows) === 0) throw new HttpError(409, 'REPLAY', 'Replayed request');

      const metrics = Object.entries(body.metrics);
      if (metrics.length) {
        await db.insertInto('telemetry').values(metrics.map(([metric, value]) => ({ id: randomUUID(), device_id: d.id, metric, value, at }))).execute();
        // Device readings tied to a patient are mirrored into the chart as vitals.
        const vitalKinds = new Set(['heart_rate', 'spo2', 'resp_rate']);
        if (d.assigned_patient_id) {
          const vitals = metrics.filter(([m]) => vitalKinds.has(m));
          if (vitals.length) {
            const units: Record<string, string> = { heart_rate: 'bpm', spo2: '%', resp_rate: 'br/min' };
            await db
              .insertInto('vitals')
              .values(vitals.map(([m, v]) => ({ id: randomUUID(), patient_id: d.assigned_patient_id!, kind: m as 'heart_rate', value: v, unit: units[m]!, source_device_id: d.id, recorded_by: null, recorded_at: at })))
              .execute();
          }
        }
        events.publish({ type: 'device.telemetry', facilityId: d.facility_id, deviceId: d.id, metrics: body.metrics, at });
        for (const [metric, value] of metrics) {
          for (const rule of THRESHOLDS[metric] ?? []) {
            const tripped = (rule.below !== undefined && value < rule.below) || (rule.above !== undefined && value > rule.above);
            if (!tripped) continue;
            await raiseAlert(ctx, {
              facility_id: d.facility_id,
              device_id: d.id,
              patient_id: rule.patientLinked ? d.assigned_patient_id : null,
              severity: rule.severity,
              kind: `threshold_${metric}`,
              message: `${rule.label} — ${d.kind} ${d.asset_tag}, ${d.location} (${value})`,
            });
          }
        }
      }
      if (status !== d.status) events.publish({ type: 'device.status', facilityId: d.facility_id, deviceId: d.id, status, at });
      return { ok: true, status, serverTime: at };
    });
  };
}

export function publicWorkOrder(w: import('../db/schema.js').WorkOrdersTable) {
  return {
    id: w.id,
    deviceId: w.device_id,
    title: w.title,
    description: w.description,
    priority: w.priority,
    status: w.status,
    assignedTo: w.assigned_to,
    createdBy: w.created_by,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
    resolvedAt: w.resolved_at,
  };
}

export function workOrderRoutes(ctx: AppContext) {
  const { db, audit, events } = ctx;
  const staff = guard(ctx, { roles: ['clinician', 'biomed_tech', 'admin'] });
  const techOrAdmin = guard(ctx, { roles: ['biomed_tech', 'admin'] });

  return async function register(app: FastifyInstance) {
    app.get('/', { preHandler: staff }, async (req) => {
      const u = currentUser(req);
      const q = z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'cancelled']).optional(), mine: z.coerce.boolean().optional() }).parse(req.query);
      let query = db
        .selectFrom('work_orders')
        .innerJoin('devices', 'devices.id', 'work_orders.device_id')
        .selectAll('work_orders')
        .select(['devices.asset_tag', 'devices.kind as device_kind', 'devices.location', 'devices.facility_id'])
        .orderBy('work_orders.created_at', 'desc')
        .limit(200);
      if (u.role !== 'admin') query = query.where('devices.facility_id', '=', u.fid!);
      if (q.status) query = query.where('work_orders.status', '=', q.status);
      if (q.mine) query = query.where('work_orders.assigned_to', '=', u.sub);
      const rows = await query.execute();
      return rows.map((r) => ({ ...publicWorkOrder(r), device: { assetTag: r.asset_tag, kind: r.device_kind, location: r.location } }));
    });

    // Any staff member can report a faulty device; only techs/admins triage it.
    app.post('/', { preHandler: staff }, async (req, reply) => {
      const u = currentUser(req);
      const b = workOrderBody.parse(req.body);
      const d = await db.selectFrom('devices').select(['id', 'facility_id']).where('id', '=', b.deviceId).executeTakeFirst();
      if (!d) throw notFound('Device');
      assertFacilityAccess(req, d.facility_id);
      const id = randomUUID();
      const at = nowIso();
      await db.insertInto('work_orders').values({ id, device_id: d.id, title: b.title, description: b.description, priority: b.priority, status: 'open', assigned_to: null, created_by: u.sub, created_at: at, updated_at: at, resolved_at: null }).execute();
      events.publish({ type: 'workorder.updated', facilityId: d.facility_id, workOrderId: id, status: 'open', at });
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'workorder.create', resourceType: 'work_order', resourceId: id, ip: req.ip });
      reply.code(201);
      return { id };
    });

    app.patch('/:id', { preHandler: techOrAdmin }, async (req) => {
      const u = currentUser(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const b = patchWorkOrderBody.parse(req.body);
      const w = await db
        .selectFrom('work_orders')
        .innerJoin('devices', 'devices.id', 'work_orders.device_id')
        .selectAll('work_orders')
        .select('devices.facility_id')
        .where('work_orders.id', '=', id)
        .executeTakeFirst();
      if (!w) throw notFound('Work order');
      assertFacilityAccess(req, w.facility_id);
      const at = nowIso();
      const patch = {
        updated_at: at,
        ...(b.status && { status: b.status, resolved_at: b.status === 'resolved' ? at : null }),
        ...(b.assignedTo !== undefined && { assigned_to: b.assignedTo }),
        ...(b.priority && { priority: b.priority }),
      };
      await db.updateTable('work_orders').set(patch).where('id', '=', id).execute();
      events.publish({ type: 'workorder.updated', facilityId: w.facility_id, workOrderId: id, status: b.status ?? w.status, at });
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'workorder.update', resourceType: 'work_order', resourceId: id, ip: req.ip, detail: b });
      const { facility_id: _f, ...rest } = w;
      return publicWorkOrder({ ...rest, ...patch });
    });
  };
}
