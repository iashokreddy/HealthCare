import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp, buildContext } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { DEMO_PASSWORD, seed } from '../src/db/seed.js';

export interface TestEnv {
  app: FastifyInstance;
  ctx: AppContext;
  login(email: string, client?: 'web' | 'mobile'): Promise<string>;
  close(): Promise<void>;
}

/**
 * In-memory SQLite by default. Set TEST_DATABASE_URL=postgres://... to run the same suite against
 * PostgreSQL; each environment gets its own throwaway schema.
 */
async function freshDatabaseUrl(): Promise<string> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return 'sqlite::memory:';
  const schema = `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const client = new pg.Client({ connectionString: base });
  await client.connect();
  await client.query(`create schema ${schema}`);
  await client.end();
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

export async function setup(overrides: Partial<Config> = {}): Promise<TestEnv> {
  const ctx = await buildContext({ NODE_ENV: 'test', DATABASE_URL: await freshDatabaseUrl(), ...overrides });
  await seed(ctx);
  const app = await buildApp(ctx);
  await app.ready();
  return {
    app,
    ctx,
    async login(email, client = 'mobile') {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: DEMO_PASSWORD, client } });
      if (res.statusCode !== 200) throw new Error(`login failed for ${email}: ${res.body}`);
      return res.json().accessToken as string;
    },
    async close() {
      await app.close();
      await ctx.db.destroy();
    },
  };
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
