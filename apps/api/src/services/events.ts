import { EventEmitter } from 'node:events';

/**
 * Real-time event bus feeding the live dashboards (Server-Sent Events).
 * This in-process implementation is fine for a single replica; with multiple replicas the same
 * interface is backed by PostgreSQL LISTEN/NOTIFY or Redis Streams so every pod sees every event.
 */
export type LiveEvent =
  | { type: 'device.status'; facilityId: string; deviceId: string; status: string; at: string }
  | { type: 'device.telemetry'; facilityId: string; deviceId: string; metrics: Record<string, number>; at: string }
  | { type: 'alert.created'; facilityId: string; alertId: string; severity: string; message: string; at: string }
  | { type: 'alert.acknowledged'; facilityId: string; alertId: string; at: string }
  | { type: 'workorder.updated'; facilityId: string; workOrderId: string; status: string; at: string };

export interface EventBus {
  publish(e: LiveEvent): void;
  subscribe(fn: (e: LiveEvent) => void): () => void;
}

export function createEventBus(): EventBus {
  const em = new EventEmitter();
  em.setMaxListeners(10_000);
  return {
    publish: (e) => em.emit('event', e),
    subscribe(fn) {
      em.on('event', fn);
      return () => em.off('event', fn);
    },
  };
}
