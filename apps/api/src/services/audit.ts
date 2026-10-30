import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { AuditLogTable } from '../db/schema.js';
import { hmacHex } from '../lib/crypto.js';

/**
 * Tamper-evident audit trail (HIPAA §164.312(b)).
 *
 * Every entry stores an HMAC over its own content plus the previous entry's hash, forming a chain.
 * Editing, deleting or re-ordering any row breaks verification from that point on. In production
 * entries are additionally streamed to write-once storage (S3 Object Lock / Azure immutable blob)
 * so even a database administrator cannot silently rewrite history.
 */
export interface AuditEvent {
  actorId: string | null;
  actorRole: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome?: AuditLogTable['outcome'];
  ip?: string | null;
  detail?: Record<string, unknown>;
}

export interface AuditService {
  record(e: AuditEvent): Promise<void>;
  verify(): Promise<{ ok: true; count: number } | { ok: false; brokenAtSeq: number; count: number }>;
}

const GENESIS = '0'.repeat(64);

function entryHash(key: Buffer, row: Omit<AuditLogTable, 'hash'>): string {
  const canonical = JSON.stringify([
    Number(row.seq), row.id, row.at, row.actor_id, row.actor_role, row.action, row.resource_type,
    row.resource_id, row.outcome, row.ip, row.detail, row.prev_hash,
  ]);
  return hmacHex(key, canonical);
}

export function createAuditService(db: Database, key: Buffer): AuditService {
  // Serialise writers within this process; across replicas the unique `seq` primary key turns a
  // race into a constraint violation, which we retry.
  let queue: Promise<unknown> = Promise.resolve();

  async function append(e: AuditEvent) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await db.transaction().execute(async (trx) => {
          const last = await trx.selectFrom('audit_log').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst();
          const row: Omit<AuditLogTable, 'hash'> = {
            seq: last ? Number(last.seq) + 1 : 1,
            id: randomUUID(),
            at: new Date().toISOString(),
            actor_id: e.actorId,
            actor_role: e.actorRole,
            action: e.action,
            resource_type: e.resourceType,
            resource_id: e.resourceId ?? null,
            outcome: e.outcome ?? 'success',
            ip: e.ip ?? null,
            detail: e.detail ? JSON.stringify(e.detail) : null,
            prev_hash: last?.hash ?? GENESIS,
          };
          await trx.insertInto('audit_log').values({ ...row, hash: entryHash(key, row) }).execute();
        });
        return;
      } catch (err) {
        if (attempt === 4) throw err;
      }
    }
  }

  return {
    record(e) {
      const p = queue.then(() => append(e));
      queue = p.catch(() => undefined);
      return p;
    },
    async verify() {
      let prev = GENESIS;
      let expectedSeq = 1;
      let count = 0;
      const pageSize = 1000;
      for (;;) {
        const rows = await db
          .selectFrom('audit_log')
          .selectAll()
          .where('seq', '>=', expectedSeq)
          .orderBy('seq', 'asc')
          .limit(pageSize)
          .execute();
        for (const r of rows) {
          const seq = Number(r.seq);
          const { hash, ...rest } = r;
          if (seq !== expectedSeq || r.prev_hash !== prev || entryHash(key, rest) !== hash) {
            return { ok: false, brokenAtSeq: expectedSeq, count };
          }
          prev = hash;
          expectedSeq++;
          count++;
        }
        if (rows.length < pageSize) return { ok: true, count };
      }
    },
  };
}
