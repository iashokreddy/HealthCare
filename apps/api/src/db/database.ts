import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Kysely, PostgresDialect, SqliteDialect, type SqliteDatabase, type SqliteStatement } from 'kysely';
import pg from 'pg';
import type { DB } from './schema.js';

/**
 * Adapts Node's built-in `node:sqlite` (zero native dependencies) to Kysely's SQLite dialect.
 * Used for local development and tests only — production runs on PostgreSQL.
 */
async function nodeSqlite(path: string): Promise<SqliteDatabase> {
  const { DatabaseSync } = await import('node:sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return {
    close: () => db.close(),
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(sql);
      const params = (p: ReadonlyArray<unknown>) => p as Parameters<typeof stmt.all>;
      return {
        reader: stmt.columns().length > 0,
        all: (p) => stmt.all(...params(p)),
        run: (p) => stmt.run(...params(p)),
        iterate: (p) => stmt.iterate(...params(p)),
      };
    },
  };
}

export type Database = Kysely<DB>;

export function createDatabase(url: string): Database {
  if (url.startsWith('sqlite:')) {
    const path = url.slice('sqlite:'.length);
    return new Kysely<DB>({ dialect: new SqliteDialect({ database: () => nodeSqlite(path) }) });
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    // TLS is required to the database in production; `sslmode=require` / verify-full on the URL.
    const pool = new pg.Pool({ connectionString: url, max: 20, idleTimeoutMillis: 30_000, statement_timeout: 10_000 });
    return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  }
  throw new Error('Unsupported DATABASE_URL scheme');
}
