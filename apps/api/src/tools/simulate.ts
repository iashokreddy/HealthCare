/**
 * Development device simulator: streams signed heartbeats for every seeded device so dashboards,
 * charts, alerts and the offline watchdog can be exercised end to end.
 *
 *   npm run simulate -w apps/api            # all devices except one (which goes "offline")
 *
 * Reads device secrets directly from the local dev database — this tool only works against
 * SQLite in development and refuses to run otherwise.
 */
import { buildContext } from '../app.js';
import { decryptField, hmacHex } from '../lib/crypto.js';

const API = process.env.SIM_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const ctx = await buildContext();
if (ctx.cfg.NODE_ENV !== 'development' || !ctx.cfg.DATABASE_URL.startsWith('sqlite:')) {
  console.error('simulate is a development-only tool');
  process.exit(1);
}

const devices = await ctx.db.selectFrom('devices').selectAll().where('status', '!=', 'maintenance').orderBy('asset_tag').execute();
const silent = devices.find((d) => d.kind === 'Defibrillator');
const secrets = new Map(devices.map((d) => [d.id, decryptField(ctx.ring, d.credential_enc, `devices:${d.id}:credential`)]));
await ctx.db.destroy();

let tick = 0;
const battery = new Map(devices.map((d) => [d.id, d.battery_pct ?? 90]));

function metricsFor(kind: string, id: string): Record<string, number> {
  const wobble = (amp: number) => Math.round((Math.sin(tick / 5) * amp + (Math.random() - 0.5) * amp) * 10) / 10;
  switch (kind) {
    case 'Patient Monitor':
      // Occasional desaturation episode to demonstrate clinical alerting.
      return { heart_rate: Math.round(78 + wobble(8)), spo2: tick % 40 > 36 ? 88 : Math.round(97 + wobble(1)), resp_rate: Math.round(16 + wobble(2)) };
    case 'Infusion Pump': {
      const b = Math.max(5, (battery.get(id) ?? 90) - 0.4);
      battery.set(id, b);
      return { battery_pct: Math.round(b), occlusion_pressure: Math.round(320 + wobble(40)) };
    }
    case 'Ventilator':
      return { temperature_c: 38 + wobble(3), resp_rate: Math.round(14 + wobble(1)) };
    default:
      return { temperature_c: 31 + wobble(1) };
  }
}

async function beat(d: (typeof devices)[number]) {
  const body = JSON.stringify({ status: d.kind === 'Ventilator' ? 'degraded' : 'online', metrics: metricsFor(d.kind, d.id) });
  const ts = String(Date.now());
  const res = await fetch(`${API}/api/v1/ingest/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': d.id, 'X-Device-Timestamp': ts, 'X-Device-Signature': hmacHex(secrets.get(d.id)!, `${ts}.${body}`) },
    body,
  });
  if (!res.ok) console.warn(`${d.asset_tag}: ${res.status} ${await res.text()}`);
}

console.log(`Simulating ${devices.length} devices against ${API}${silent ? ` (${silent.asset_tag} will stay silent → offline alert)` : ''}`);
setInterval(() => {
  tick++;
  for (const d of devices) if (d !== silent) void beat(d).catch((e) => console.warn(d.asset_tag, e.message));
}, 5000);
