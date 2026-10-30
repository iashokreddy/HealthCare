import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { assertFacilityAccess, currentUser, guard } from '../lib/auth.js';
import { blindIndex, decryptField, encryptField, hashPassword } from '../lib/crypto.js';
import { conflict, notFound, nowIso } from '../lib/http.js';
import type { LiveEvent } from '../services/events.js';

/** Alerts, dashboard summary, live event stream, user administration and audit access. */
export function alertRoutes(ctx: AppContext) {
  const { db, audit, events } = ctx;
  const staff = guard(ctx, { roles: ['clinician', 'biomed_tech', 'admin'] });

  return async function register(app: FastifyInstance) {
    app.get('/', { preHandler: staff }, async (req) => {
      const u = currentUser(req);
      const q = z.object({ open: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
      let query = db.selectFrom('alerts').selectAll().orderBy('created_at', 'desc').limit(q.limit);
      if (u.role !== 'admin') query = query.where('facility_id', '=', u.fid!);
      if (q.open === 'true') query = query.where('acknowledged_at', 'is', null);
      // Patient-linked clinical alerts are hidden from biomedical techs (minimum necessary).
      if (u.role === 'biomed_tech') query = query.where('patient_id', 'is', null);
      return (await query.execute()).map((a) => ({
        id: a.id,
        facilityId: a.facility_id,
        deviceId: a.device_id,
        patientId: a.patient_id,
        severity: a.severity,
        kind: a.kind,
        message: a.message,
        createdAt: a.created_at,
        acknowledgedBy: a.acknowledged_by,
        acknowledgedAt: a.acknowledged_at,
      }));
    });

    app.post('/:id/ack', { preHandler: staff }, async (req) => {
      const u = currentUser(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const a = await db.selectFrom('alerts').selectAll().where('id', '=', id).executeTakeFirst();
      if (!a) throw notFound('Alert');
      assertFacilityAccess(req, a.facility_id);
      const at = nowIso();
      await db.updateTable('alerts').set({ acknowledged_by: u.sub, acknowledged_at: at }).where('id', '=', id).where('acknowledged_at', 'is', null).execute();
      events.publish({ type: 'alert.acknowledged', facilityId: a.facility_id, alertId: id, at });
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'alert.ack', resourceType: 'alert', resourceId: id, ip: req.ip });
      return { id, acknowledgedAt: a.acknowledged_at ?? at };
    });
  };
}

export function dashboardRoutes(ctx: AppContext) {
  const { db } = ctx;
  return async function register(app: FastifyInstance) {
    app.get('/summary', { preHandler: guard(ctx, { roles: ['clinician', 'biomed_tech', 'admin'] }) }, async (req) => {
      const u = currentUser(req);
      const scope = <T extends { where: (...a: any[]) => T }>(q: T, col: string) => (u.role === 'admin' ? q : q.where(col, '=', u.fid));
      const devices = await scope(db.selectFrom('devices').select(['status', sql<number>`count(*)`.as('n')]).groupBy('status'), 'facility_id').execute();
      const alerts = await scope(db.selectFrom('alerts').select(['severity', sql<number>`count(*)`.as('n')]).where('acknowledged_at', 'is', null).groupBy('severity'), 'facility_id').execute();
      const workOrders = await scope(
        db.selectFrom('work_orders').innerJoin('devices', 'devices.id', 'work_orders.device_id').select(['work_orders.status', sql<number>`count(*)`.as('n')]).groupBy('work_orders.status'),
        'devices.facility_id',
      ).execute();
      const dueSoon = await scope(
        db.selectFrom('devices').select(sql<number>`count(*)`.as('n')).where('next_service_due', '<=', new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)),
        'facility_id',
      ).executeTakeFirst();
      const toMap = (rows: { n: number | string }[], key: string): Record<string, number> =>
        Object.fromEntries(rows.map((r: any) => [r[key], Number(r.n)]));
      const deviceCounts = toMap(devices, 'status');
      const total = Object.values(deviceCounts).reduce((a, b) => a + b, 0);
      const available = (deviceCounts.online ?? 0) + (deviceCounts.degraded ?? 0);
      return {
        devices: deviceCounts,
        fleetAvailabilityPct: total ? Math.round((available / total) * 1000) / 10 : 100,
        openAlerts: toMap(alerts, 'severity'),
        workOrders: toMap(workOrders, 'status'),
        servicesDueIn14Days: Number(dueSoon?.n ?? 0),
      };
    });
  };
}

/**
 * Server-Sent Events stream for live dashboards. Clients authenticate with the normal bearer
 * header (fetch-based SSE), and only receive events for facilities they can access.
 */
export function eventRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance) {
    app.get('/', { preHandler: guard(ctx, { roles: ['clinician', 'biomed_tech', 'admin'] }) }, async (req, reply) => {
      const u = currentUser(req);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\n\n`);
      const send = (e: LiveEvent) => {
        if (u.role !== 'admin' && e.facilityId !== u.fid) return;
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      const unsubscribe = ctx.events.subscribe(send);
      const ping = setInterval(() => res.write(`: ping\n\n`), 20_000);
      req.raw.on('close', () => {
        clearInterval(ping);
        unsubscribe();
      });
    });
  };
}

const createUserBody = z.object({
  email: z.string().email().max(254),
  displayName: z.string().min(1).max(120),
  role: z.enum(['patient', 'clinician', 'biomed_tech', 'admin']),
  facilityId: z.string().nullable().default(null),
  patientId: z.string().nullable().default(null),
  // NIST SP 800-63B: length over complexity rules.
  password: z.string().min(12).max(256),
});

export function userRoutes(ctx: AppContext) {
  const { db, ring, audit } = ctx;
  const admin = guard(ctx, { roles: ['admin'] });
  return async function register(app: FastifyInstance) {
    app.get('/', { preHandler: admin }, async () => {
      const rows = await db.selectFrom('users').selectAll().orderBy('display_name').execute();
      return rows.map((u) => ({
        id: u.id,
        email: decryptField(ring, u.email_enc, `users:${u.id}:email`),
        displayName: u.display_name,
        role: u.role,
        facilityId: u.facility_id,
        mfaEnabled: u.mfa_enabled === 1,
        locked: !!u.locked_until && new Date(u.locked_until).getTime() > Date.now(),
        disabled: u.disabled === 1,
      }));
    });

    // Directory of clinicians, so patients and staff can book appointments.
    app.get('/clinicians', { preHandler: guard(ctx) }, async () => {
      const rows = await db
        .selectFrom('users')
        .innerJoin('facilities', 'facilities.id', 'users.facility_id')
        .select(['users.id', 'users.display_name', 'facilities.name as facility_name'])
        .where('role', '=', 'clinician')
        .where('disabled', '=', 0)
        .execute();
      return rows.map((r) => ({ id: r.id, displayName: r.display_name, facilityName: r.facility_name }));
    });

    app.post('/', { preHandler: admin }, async (req, reply) => {
      const actor = currentUser(req);
      const b = createUserBody.parse(req.body);
      const bidx = blindIndex(ring, b.email, 'email');
      if (await db.selectFrom('users').select('id').where('email_bidx', '=', bidx).executeTakeFirst()) throw conflict('Email already registered');
      const id = randomUUID();
      await db
        .insertInto('users')
        .values({
          id,
          email_bidx: bidx,
          email_enc: encryptField(ring, b.email.toLowerCase(), `users:${id}:email`),
          display_name: b.displayName,
          password_hash: await hashPassword(b.password),
          role: b.role,
          facility_id: b.facilityId,
          patient_id: b.patientId,
          mfa_secret_enc: null,
          mfa_enabled: 0,
          mfa_last_counter: null,
          failed_logins: 0,
          locked_until: null,
          disabled: 0,
          created_at: nowIso(),
        })
        .execute();
      await audit.record({ actorId: actor.sub, actorRole: actor.role, action: 'user.create', resourceType: 'user', resourceId: id, ip: req.ip, detail: { role: b.role } });
      reply.code(201);
      return { id };
    });

    app.patch('/:id', { preHandler: admin }, async (req) => {
      const actor = currentUser(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const b = z.object({ disabled: z.boolean().optional(), unlock: z.boolean().optional() }).parse(req.body);
      const user = await db.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst();
      if (!user) throw notFound('User');
      await db
        .updateTable('users')
        .set({
          ...(b.disabled !== undefined && { disabled: b.disabled ? 1 : 0 }),
          ...(b.unlock && { locked_until: null, failed_logins: 0 }),
        })
        .where('id', '=', id)
        .execute();
      // Disabling a user kills all of their sessions immediately.
      if (b.disabled) await db.updateTable('refresh_tokens').set({ revoked_at: nowIso() }).where('user_id', '=', id).where('revoked_at', 'is', null).execute();
      await audit.record({ actorId: actor.sub, actorRole: actor.role, action: 'user.update', resourceType: 'user', resourceId: id, ip: req.ip, detail: b });
      return { id, ...b };
    });
  };
}

export function auditRoutes(ctx: AppContext) {
  const { db, audit } = ctx;
  const admin = guard(ctx, { roles: ['admin'] });
  return async function register(app: FastifyInstance) {
    app.get('/', { preHandler: admin }, async (req) => {
      const q = z
        .object({
          before: z.coerce.number().int().positive().optional(),
          action: z.string().max(60).optional(),
          actorId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(req.query);
      let query = db.selectFrom('audit_log').selectAll().orderBy('seq', 'desc').limit(q.limit);
      if (q.before) query = query.where('seq', '<', q.before);
      if (q.action) query = query.where('action', 'like', `${q.action.replace(/[%_]/g, '')}%`);
      if (q.actorId) query = query.where('actor_id', '=', q.actorId);
      const rows = await query.execute();
      return rows.map((r) => ({ ...r, seq: Number(r.seq), detail: r.detail ? JSON.parse(r.detail) : null }));
    });

    app.get('/verify', { preHandler: admin }, async (req) => {
      const u = currentUser(req);
      const result = await audit.verify();
      await audit.record({ actorId: u.sub, actorRole: u.role, action: 'audit.verify', resourceType: 'audit_log', ip: req.ip, detail: result });
      return result;
    });
  };
}

export function facilityRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance) {
    app.get('/', { preHandler: guard(ctx) }, async () => ctx.db.selectFrom('facilities').selectAll().orderBy('name').execute());
  };
}
