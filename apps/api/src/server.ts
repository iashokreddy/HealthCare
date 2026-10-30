import { setTimeout as sleep } from 'node:timers/promises';
import { buildApp, buildContext } from './app.js';
import { seedIfEmpty } from './db/seed.js';
import { startWatchdog } from './services/watchdog.js';

const ctx = await buildContext();
if (ctx.cfg.NODE_ENV === 'development') {
  const seeded = await seedIfEmpty(ctx);
  if (seeded) console.log(seeded);
}
const app = await buildApp(ctx);
const stopWatchdog = startWatchdog(ctx);

await app.listen({ host: ctx.cfg.HOST, port: ctx.cfg.PORT });

// Graceful shutdown: stop advertising readiness, let the load balancer drain, finish in-flight
// requests, then close the DB pool. Combined with rolling updates this gives zero-downtime deploys.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    app.markNotReady();
    stopWatchdog();
    if (ctx.cfg.NODE_ENV === 'production') await sleep(10_000);
    await app.close();
    await ctx.db.destroy();
    process.exit(0);
  });
}
