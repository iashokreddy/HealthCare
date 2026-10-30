import type { AppContext } from '../context.js';
import { raiseAlert } from './alerts.js';

/**
 * Equipment heartbeat watchdog: any connected device that stops reporting is flagged offline and
 * an alert is raised, so failures are caught by the system — not discovered at the bedside.
 * Safe to run on every replica: the status update is a conditional write, so only one wins.
 */
export async function sweepStaleDevices(ctx: AppContext, now = Date.now()): Promise<string[]> {
  const cutoff = new Date(now - ctx.cfg.DEVICE_HEARTBEAT_TIMEOUT_SECONDS * 1000).toISOString();
  const stale = await ctx.db
    .selectFrom('devices')
    .select(['id', 'facility_id', 'asset_tag', 'kind', 'location', 'status'])
    .where('status', 'in', ['online', 'degraded'])
    .where('last_heartbeat_at', '<', cutoff)
    .execute();

  const flagged: string[] = [];
  for (const d of stale) {
    const res = await ctx.db
      .updateTable('devices')
      .set({ status: 'offline' })
      .where('id', '=', d.id)
      .where('status', '=', d.status)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) continue;
    flagged.push(d.id);
    const at = new Date(now).toISOString();
    ctx.events.publish({ type: 'device.status', facilityId: d.facility_id, deviceId: d.id, status: 'offline', at });
    await raiseAlert(ctx, {
      facility_id: d.facility_id,
      device_id: d.id,
      severity: 'critical',
      kind: 'device_offline',
      message: `${d.kind} ${d.asset_tag} (${d.location}) stopped reporting`,
    });
    await ctx.audit.record({
      actorId: null,
      actorRole: 'system',
      action: 'device.offline_detected',
      resourceType: 'device',
      resourceId: d.id,
    });
  }
  return flagged;
}

export function startWatchdog(ctx: AppContext, intervalMs = 15_000) {
  const timer = setInterval(() => {
    sweepStaleDevices(ctx).catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
