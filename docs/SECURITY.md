# Security architecture

How CareBridge protects patient data (PHI) and connected medical equipment, and where each control lives in the code.

## Threat model (summary)

| Threat | Primary controls |
|---|---|
| Stolen database dump or backup | Field-level envelope encryption of PHI and secrets; blind indexes instead of plaintext lookup columns |
| Credential stuffing / brute force | scrypt hashing, constant-time login for unknown users, account lockout, per-route rate limits |
| Stolen session token | 10-minute access tokens held in memory only; rotating refresh tokens with reuse detection that revokes the whole session family |
| XSS exfiltrating sessions | Refresh token in `HttpOnly; SameSite=Strict` cookie scoped to `/api/v1/auth`; strict CSP |
| CSRF | SameSite=Strict, plus a required custom header on cookie-based refresh (forces a CORS preflight) |
| Insider snooping on records | Facility-scoped ABAC, minimum-necessary role rules, every PHI read audited, break-glass raises a privacy alert |
| Audit log tampering | HMAC hash chain with `/audit/verify`; production also streams entries to WORM storage |
| Spoofed or replayed device telemetry | Per-device HMAC-SHA256 signatures over timestamp and body, a freshness window, and strictly increasing timestamps |
| Silent equipment failure | Heartbeat watchdog flags devices offline and raises critical alerts; threshold alerts are de-duplicated to limit alarm fatigue |
| Lost or shared device (mobile/web) | Keychain/Keystore storage (this-device-only), biometric re-lock, screenshot blocking, 15-minute web idle sign-out |

## Controls in code

### Encryption

[lib/crypto.ts](../apps/api/src/lib/crypto.ts)

- AES-256-GCM envelope encryption: a fresh data key per value, wrapped by the key-encryption key (KEK). Each ciphertext is bound to its `table:id:column` via AAD, so it can't be copied to another row or column.
- KEK rotation only re-wraps data keys. In production the KEK comes from a KMS or HSM.
- Blind indexes (HMAC-SHA256 with a separate key) make MRN and email exact-match searchable without decryption.
- In transit: TLS at the edge with HSTS preload; TLS to PostgreSQL (`sslmode=verify-full`).

### Authentication

[routes/auth.ts](../apps/api/src/routes/auth.ts)

- Passwords are hashed with scrypt (N=2^15) and encoded parameters. Policy is a 12-character minimum (NIST SP 800-63B).
- TOTP MFA (RFC 6238) rejects reuse of a previously accepted code. MFA is mandatory for staff when `REQUIRE_STAFF_MFA=true`, and production enforces it.
- Access tokens are Ed25519 JWTs. Issuer, audience, `typ` and algorithm are pinned. The public JWKS is served at `/.well-known/jwks.json`.

### Authorization

[lib/auth.ts](../apps/api/src/lib/auth.ts)

- Deny by default: every non-public route has a guard with explicit roles.
- Facility attribute checks apply to every patient, device, alert and work-order access.
- Patients can reach only their own chart. Biomedical techs never receive PHI, and patient-linked alerts are filtered out for them.
- Break-glass (clinicians only) requires a written reason (at least 10 characters). It is audited and raises an alert for the privacy office.

### Audit

[services/audit.ts](../apps/api/src/services/audit.ts)

- Records PHI reads and writes, logins (success and failure), authorization denials, MFA changes, device registration and credential rotation, and admin actions.
- Each entry includes the previous entry's hash, so any edit, deletion or reorder shows up at the first broken sequence number.

### API hardening

[app.ts](../apps/api/src/app.ts)

- Helmet security headers and an origin allow-list for CORS.
- Body-size limits and request timeouts.
- Zod validation on every input.
- Generic 500 responses that include a request ID and no internal detail.
- Authorization headers, cookies and signatures are redacted from logs.
- Every `/api` response sends `Cache-Control: no-store`.

### Devices

[routes/devices.ts](../apps/api/src/routes/devices.ts)

- Each device has a secret, shown once at registration and rotatable.
- Production adds mutual TLS with per-device certificates at the ingest gateway, on a segmented medical-device VLAN.

### Containers

[infra](../infra)

- Images run as non-root with a read-only root filesystem, all capabilities dropped and `no-new-privileges`.
- The database sits on an internal-only network.

## HIPAA Security Rule mapping (technical safeguards, §164.312)

| Requirement | Implementation |
|---|---|
| (a)(1) Access control: unique user identification | Per-user accounts; UUID subject in every token and audit entry |
| (a)(2)(ii) Emergency access procedure | Break-glass header flow with mandatory reason, audit entry and privacy alert |
| (a)(2)(iii) Automatic logoff | 15-minute web idle timeout, mobile background re-lock, 10-minute access tokens, 12-hour refresh lifetime |
| (a)(2)(iv) Encryption and decryption | AES-256-GCM field encryption at rest; TLS in transit |
| (b) Audit controls | Hash-chained audit log, verification endpoint, admin audit viewer |
| (c)(1) Integrity | GCM authentication tags on PHI; audit chain; signed device telemetry |
| (d) Person or entity authentication | scrypt passwords, TOTP MFA, lockout, signed tokens; device HMAC/mTLS |
| (e)(1) Transmission security | HSTS, TLS-only CORS origins in production, ATS / no cleartext on mobile |

The administrative and physical safeguards (risk analysis, workforce training, BAAs, contingency plans, facility access) are organisational and must be addressed outside this codebase.

## Production checklist

- [ ] KEK and blind-index key in KMS/HSM; JWT signing key in a secrets manager; documented rotation runbook
- [ ] PostgreSQL with TLS `verify-full`, encrypted storage, PITR backups, and a tested restore
- [ ] Audit log streamed to WORM storage (S3 Object Lock / Azure immutable blob)
- [ ] Multi-replica event bus (PostgreSQL LISTEN/NOTIFY or Redis) for SSE
- [ ] WAF and edge rate limiting; mTLS gateway for device ingest
- [ ] Penetration test, and a threat-model review for each release
- [ ] BAA with every vendor that touches PHI
