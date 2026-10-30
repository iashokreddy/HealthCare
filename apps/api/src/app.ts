import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { ZodError } from 'zod';
import { loadConfig, type Config } from './config.js';
import type { AppContext } from './context.js';
import { createDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';
import { createKeyring, hmacHex } from './lib/crypto.js';
import { HttpError } from './lib/http.js';
import { appointmentRoutes } from './routes/appointments.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes, ingestRoutes, workOrderRoutes } from './routes/devices.js';
import { alertRoutes, auditRoutes, dashboardRoutes, eventRoutes, facilityRoutes, userRoutes } from './routes/operations.js';
import { patientRoutes } from './routes/patients.js';
import { createAuditService } from './services/audit.js';
import { createEventBus } from './services/events.js';
import { createTokenService } from './services/tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

/**
 * Local development only: persist generated keys next to the SQLite file so encrypted data and
 * sessions survive restarts. Production refuses to boot without real keys (see config.ts).
 */
function loadDevKeys(cfg: Config): Config {
  if (cfg.NODE_ENV !== 'development' || !cfg.DATABASE_URL.startsWith('sqlite:') || cfg.DATABASE_URL.endsWith(':memory:')) return cfg;
  const file = join(dirname(cfg.DATABASE_URL.slice('sqlite:'.length)), 'dev-keys.json');
  let keys: { DATA_KEK: string; BLIND_INDEX_KEY: string; JWT_PRIVATE_KEY: string };
  if (existsSync(file)) {
    keys = JSON.parse(readFileSync(file, 'utf8'));
  } else {
    keys = {
      DATA_KEK: randomBytes(32).toString('base64'),
      BLIND_INDEX_KEY: randomBytes(32).toString('base64'),
      JWT_PRIVATE_KEY: generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  }
  return {
    ...cfg,
    DATA_KEK: cfg.DATA_KEK ?? keys.DATA_KEK,
    BLIND_INDEX_KEY: cfg.BLIND_INDEX_KEY ?? keys.BLIND_INDEX_KEY,
    JWT_PRIVATE_KEY: cfg.JWT_PRIVATE_KEY ?? keys.JWT_PRIVATE_KEY,
  };
}

export async function buildContext(overrides: Partial<Config> = {}): Promise<AppContext> {
  const cfg = loadDevKeys({ ...loadConfig(), ...overrides });
  const db = createDatabase(cfg.DATABASE_URL);
  await migrate(db);
  const ring = createKeyring(cfg.DATA_KEK, cfg.BLIND_INDEX_KEY);
  const auditKey = Buffer.from(hmacHex(ring.keks.get(ring.activeKekId)!, 'audit-chain-key'), 'hex');
  return {
    cfg,
    db,
    ring,
    tokens: createTokenService({ privateKeyPem: cfg.JWT_PRIVATE_KEY, issuer: cfg.JWT_ISSUER, accessTtl: cfg.ACCESS_TOKEN_TTL_SECONDS }),
    audit: createAuditService(db, auditKey),
    events: createEventBus(),
  };
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const { cfg } = ctx;
  let ready = true;

  const app = Fastify({
    logger:
      cfg.NODE_ENV === 'test'
        ? false
        : {
            level: cfg.LOG_LEVEL,
            // Never write credentials, tokens or PHI into logs.
            redact: {
              paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-device-signature"]', 'res.headers["set-cookie"]'],
              censor: '[REDACTED]',
            },
          },
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
    trustProxy: cfg.NODE_ENV === 'production',
    bodyLimit: 256 * 1024,
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
  });

  app.decorateRequest('user', null);
  app.decorateRequest('breakGlassReason', null);

  // Keep the exact request bytes so device HMAC signatures can be verified.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError(400, 'INVALID_JSON', 'Malformed JSON body'), undefined);
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  });
  const origins = cfg.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || origins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With', 'X-Request-Id', 'X-Break-Glass-Reason'],
    maxAge: 600,
  });
  await app.register(cookie);
  // Per-replica limits; production also rate-limits at the WAF / API gateway.
  if (cfg.NODE_ENV !== 'test') {
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: '1 minute',
      allowList: (req) => req.url === '/healthz' || req.url === '/readyz',
    });
  }

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Request-Id', req.id);
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: 'Invalid request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    }
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message } });
    }
    // Unknown errors: log full detail server-side, return nothing internal to the client.
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong', requestId: req.id } });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));

  // ---- Health probes (Kubernetes liveness/readiness; load balancer health checks) ----
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await sql`select 1`.execute(ctx.db);
      if (!ready) throw new Error('draining');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.get('/.well-known/jwks.json', async () => ({ keys: [ctx.tokens.publicJwk()] }));

  // ---- API v1 ----
  await app.register(
    async (api) => {
      await api.register(authRoutes(ctx), { prefix: '/auth' });
      await api.register(patientRoutes(ctx), { prefix: '/patients' });
      await api.register(appointmentRoutes(ctx), { prefix: '/appointments' });
      await api.register(deviceRoutes(ctx), { prefix: '/devices' });
      await api.register(ingestRoutes(ctx), { prefix: '/ingest' });
      await api.register(workOrderRoutes(ctx), { prefix: '/work-orders' });
      await api.register(alertRoutes(ctx), { prefix: '/alerts' });
      await api.register(dashboardRoutes(ctx), { prefix: '/dashboard' });
      await api.register(eventRoutes(ctx), { prefix: '/events' });
      await api.register(userRoutes(ctx), { prefix: '/users' });
      await api.register(auditRoutes(ctx), { prefix: '/audit' });
      await api.register(facilityRoutes(ctx), { prefix: '/facilities' });
    },
    { prefix: '/api/v1' },
  );

  // Fail readiness first on shutdown so the load balancer drains traffic before we stop.
  app.decorate('markNotReady', () => {
    ready = false;
  });

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    markNotReady: () => void;
  }
}
