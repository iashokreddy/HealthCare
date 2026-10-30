# CareBridge

Secure patient-care and medical-equipment reliability platform: one API serving a web console and a mobile app.

- **Patients** view their vitals and connected devices, and book or cancel appointments.
- **Clinicians** work with charts, vitals and encrypted clinical notes for their facility, and can use audited break-glass access in an emergency.
- **Biomedical technicians** monitor the device fleet live, triage work orders and take equipment out of service. They never see PHI.
- **Administrators** manage users and verify the tamper-evident audit log.

| Path | What |
|---|---|
| [apps/api](apps/api) | Fastify + TypeScript API, Kysely (PostgreSQL in production, built-in SQLite for dev/test) |
| [apps/web](apps/web) | React + Vite web console |
| [apps/mobile](apps/mobile) | Expo / React Native app (iOS + Android) |
| [infra](infra) | Dockerfiles, nginx config with security headers, Compose stack on PostgreSQL |
| [docs/SECURITY.md](docs/SECURITY.md) | Security architecture and HIPAA safeguard mapping |

## Run locally

Requires Node.js 22.5+ (24 recommended). Dev needs no database server and no native modules.

```sh
npm install
npm run dev:api      # http://localhost:4000 — creates & seeds apps/api/data/ on first run
npm run dev:web      # http://localhost:5173 (proxies /api to the API)
npm run simulate     # optional: streams signed telemetry from the seeded devices
```

Demo accounts are synthetic, and all use the password `CareBridge!2026`:

| Role | Email |
|---|---|
| Clinician (Northside) | `dr.chen@carebridge.test` |
| Clinician (Lakeview) | `dr.ali@carebridge.test` |
| Biomedical tech | `tech.lee@carebridge.test` |
| Admin | `admin@carebridge.test` |
| Patient | `jordan@carebridge.test` |

To try break-glass, sign in as `dr.ali` and open a Northside patient's URL.

To reset local data, delete `apps/api/data/` (it holds the database and dev-only encryption keys).

Mobile app: `cd apps/mobile && npm install && npm start`. The Android emulator reaches the API at `10.0.2.2:4000`. Change `extra.apiUrl` in [app.json](apps/mobile/app.json) for a device or simulator.

## Test

```sh
npm test                                   # API suite on in-memory SQLite
TEST_DATABASE_URL=postgres://u:p@host/db npm test   # same suite on PostgreSQL
npm run typecheck
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs both database variants, builds web and container images, typechecks mobile, and fails on high or critical dependency and image vulnerabilities.

## Production-like stack

```sh
node infra/gen-keys.mjs > infra/.env
docker compose -f infra/docker-compose.yml --env-file infra/.env up --build    # https terminates in front; web on :8080
docker compose -f infra/docker-compose.yml exec api node dist/tools/create-admin.js you@hospital.org "Your Name"
```

In production the API refuses to start without real keys, enforced staff MFA, PostgreSQL and https-only CORS origins. See [config.ts](apps/api/src/config.ts).

> This is a reference implementation. Before handling real PHI you need a signed BAA with your hosting provider, KMS-managed keys, an independent security assessment, and the organisational HIPAA safeguards (policies, training, risk analysis). These cannot be delivered in code.
