import { z } from 'zod';

/**
 * All configuration comes from the environment and is validated at boot.
 * The process refuses to start in production with insecure settings.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),
  /** `sqlite:<path>` / `sqlite::memory:` for local dev, `postgres://...` for production. */
  DATABASE_URL: z.string().default('sqlite:./data/carebridge.db'),
  /** Comma-separated list of allowed browser origins. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /**
   * Base64 32-byte key-encryption key (KEK). In production this is fetched from a KMS/HSM
   * (AWS KMS, Azure Key Vault, GCP KMS) and never stored on disk.
   */
  DATA_KEK: z.string().optional(),
  /** Separate base64 32-byte key used for HMAC blind indexes (searchable encrypted fields). */
  BLIND_INDEX_KEY: z.string().optional(),
  /** Ed25519 private key (PKCS8 PEM) used to sign access tokens. Generated ephemerally in dev. */
  JWT_PRIVATE_KEY: z
    .string()
    .optional()
    .transform((v) => v?.replace(/\\n/g, '\n')),
  JWT_ISSUER: z.string().default('carebridge-api'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 12),
  /** Staff roles must complete MFA before touching PHI or equipment controls. */
  REQUIRE_STAFF_MFA: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Seconds without a heartbeat before a device is flagged offline. */
  DEVICE_HEARTBEAT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(90),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = schema.parse(env);
  if (cfg.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (!cfg.DATA_KEK) problems.push('DATA_KEK is required');
    if (!cfg.BLIND_INDEX_KEY) problems.push('BLIND_INDEX_KEY is required');
    if (!cfg.JWT_PRIVATE_KEY) problems.push('JWT_PRIVATE_KEY is required');
    if (!cfg.REQUIRE_STAFF_MFA) problems.push('REQUIRE_STAFF_MFA must be true');
    if (cfg.DATABASE_URL.startsWith('sqlite:')) problems.push('SQLite is not supported in production');
    if (cfg.CORS_ORIGINS.split(',').some((o) => o.trim() === '*' || o.startsWith('http://')))
      problems.push('CORS_ORIGINS must be explicit https origins');
    if (problems.length) throw new Error(`Refusing to start with insecure config:\n - ${problems.join('\n - ')}`);
  }
  return cfg;
}
