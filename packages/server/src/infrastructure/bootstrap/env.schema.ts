import { z } from 'zod';

/**
 * Environment schema of the API and worker processes.
 *
 * Configuration has exactly one entrance: these variables, parsed once at startup
 * (stack.md, «Конфигурация и env»). A misconfiguration must be a refusal to start with a sentence
 * naming the variable — not a 500 an hour later from a code path nobody exercised in dev.
 *
 * Messages here are deliberately **not** i18n keys: the audience is the operator reading container
 * logs, not a user reading a form. That is the documented exception to rules/i18n.mdc.
 */

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
/** Mirrors Meilisearch's own `MEILI_ENV`, which only knows these two. */
export const MEILI_ENVS = ['development', 'production'] as const;

export const APP_ENCRYPTION_KEY_BYTES = 32;
export const JWT_SECRET_MIN_LENGTH = 32;

/**
 * Markers of a value that was never replaced: the `CHANGE_ME_…` placeholders of `.env.example` and
 * the `dev_…` fallbacks baked into `docker-compose.yml`. Rejected in production, warned about in
 * development (rules/security.mdc, docs/security/threat-model.md T-SH-01).
 */
export const INSECURE_VALUE_MARKERS = ['CHANGE_ME', 'dev_'] as const;

/** Variables that carry a secret, or a connection string containing one. */
export const SECRET_BEARING_ENV_KEYS = [
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'APP_ENCRYPTION_KEY',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'SMTP_URL',
  'MEILI_MASTER_KEY',
] as const;

/** Variables with no default: the process cannot start without them. */
export const REQUIRED_ENV_KEYS = [
  'APP_URL',
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'APP_ENCRYPTION_KEY',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
] as const;

const urlWithScheme = (schemes: readonly string[], variable: string) =>
  z
    .url({ error: `${variable} must be a URL` })
    .refine((value) => schemes.some((scheme) => value.startsWith(`${scheme}://`)), {
      error: `${variable} must use one of these schemes: ${schemes.join(', ')}`,
    });

const isBase64Bytes = (value: string, bytes: number): boolean => {
  // `atob` over `Buffer`: this file is the boundary, not a Node-only module, and the check must
  // reject a string that merely *looks* like base64 rather than silently truncating it.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;

  try {
    return atob(value).length === bytes;
  } catch {
    return false;
  }
};

const port = z.coerce
  .number({ error: 'PORT must be a number' })
  .int({ error: 'PORT must be a whole number' })
  .min(1, { error: 'PORT must be between 1 and 65535' })
  .max(65_535, { error: 'PORT must be between 1 and 65535' });

const argon2Cost = (variable: string, fallback: number) =>
  z.coerce
    .number({ error: `${variable} must be a number` })
    .int({ error: `${variable} must be a whole number` })
    .positive({ error: `${variable} must be positive` })
    .default(fallback);

/**
 * Boolean out of a shell variable, which is always a string.
 *
 * The fallback is applied inside the transform rather than through `.default()`: in Zod 4 a default
 * short-circuits the pipeline and would hand the literal string `"false"` to the caller as if it
 * were a boolean.
 */
const envBoolean = (variable: string, fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'], {
      error: `${variable} must be one of: true, false, 1, 0`,
    })
    .optional()
    .transform((value) => (value === undefined ? fallback : value === 'true' || value === '1'));

const fields = z.object({
  NODE_ENV: z
    .enum(NODE_ENVS, { error: `NODE_ENV must be one of: ${NODE_ENVS.join(', ')}` })
    .default('development'),
  PORT: port.default(3000),
  /** Base URL of the installation: CORS allow-list, cookie domain and links inside emails. */
  APP_URL: z.url({ error: 'APP_URL must be an absolute URL, for example https://crm.example.com' }),
  /** Extra browser origins allowed by CORS, comma-separated. */
  CORS_EXTRA_ORIGINS: z.string().optional(),

  DATABASE_URL: urlWithScheme(['postgres', 'postgresql'], 'DATABASE_URL'),
  /**
   * Owner-role connection used by `prisma migrate deploy` only.
   *
   * Optional in the schema, but **not** optional in practice: `DATABASE_URL` is `app_user`, which
   * holds `USAGE` on `public` and no `CREATE`, so falling back to it makes the migration fail on
   * `_prisma_migrations` with `permission denied for schema public` — verified against the dev
   * container. It stays `.optional()` only because turning a variable into a hard requirement
   * stops every existing installation from starting (rules/self-host-packaging.mdc, rule 2); the
   * absence is caught at migration time, not at boot. `.env.example` says the same.
   */
  DATABASE_MIGRATION_URL: urlWithScheme(
    ['postgres', 'postgresql'],
    'DATABASE_MIGRATION_URL',
  ).optional(),
  REDIS_URL: urlWithScheme(['redis', 'rediss'], 'REDIS_URL'),

  JWT_SECRET: z.string().min(JWT_SECRET_MIN_LENGTH, {
    error: `JWT_SECRET must contain at least ${JWT_SECRET_MIN_LENGTH} character(s)`,
  }),
  APP_ENCRYPTION_KEY: z.string().refine((value) => isBase64Bytes(value, APP_ENCRYPTION_KEY_BYTES), {
    error: 'APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded',
  }),

  S3_ENDPOINT: z.url({ error: 'S3_ENDPOINT must be a URL' }),
  S3_BUCKET: z.string().min(1, { error: 'S3_BUCKET must not be empty' }),
  S3_ACCESS_KEY: z.string().min(1, { error: 'S3_ACCESS_KEY must not be empty' }),
  S3_SECRET_KEY: z.string().min(1, { error: 'S3_SECRET_KEY must not be empty' }),
  S3_REGION: z.string().min(1).default('us-east-1'),
  /** MinIO and most S3-compatible servers need path-style addressing; AWS S3 does not. */
  S3_FORCE_PATH_STYLE: envBoolean('S3_FORCE_PATH_STYLE', true),

  /** Absent → outgoing mail is written to the log in dev and fails loudly in production. */
  SMTP_URL: urlWithScheme(['smtp', 'smtps'], 'SMTP_URL').optional(),

  /** Absent → `SearchPort` falls back to PostgreSQL FTS (ADR-0011). */
  MEILI_HOST: z.url({ error: 'MEILI_HOST must be a URL' }).optional(),
  MEILI_MASTER_KEY: z.string().min(1).optional(),
  MEILI_ENV: z
    .enum(MEILI_ENVS, { error: `MEILI_ENV must be one of: ${MEILI_ENVS.join(', ')}` })
    .optional(),

  /**
   * Installation-wide switch only. Provider API keys are entered by an organization admin in the
   * UI and stored encrypted in `AIProvider` — they never live in env (ADR-0014).
   */
  AI_ENABLED: envBoolean('AI_ENABLED', false),

  LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: `LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}` })
    .default('info'),
  /** Absent → traces are not exported; logs and metrics keep working. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .url({ error: 'OTEL_EXPORTER_OTLP_ENDPOINT must be a URL' })
    .optional(),

  /** Deliberate exception for the `minimal` profile, never the default (stack.md, `main.ts`). */
  RUN_WORKERS_IN_PROCESS: envBoolean('RUN_WORKERS_IN_PROCESS', false),

  ARGON2_MEMORY_COST: argon2Cost('ARGON2_MEMORY_COST', 19_456),
  ARGON2_TIME_COST: argon2Cost('ARGON2_TIME_COST', 2),
  ARGON2_PARALLELISM: argon2Cost('ARGON2_PARALLELISM', 1),
});

type EnvFields = z.infer<typeof fields>;

/**
 * Every variable the server reads, in declaration order.
 *
 * Exported because the refined schema below is no longer a `ZodObject` and has no `.shape`:
 * `test/env/env-example-sync.test.ts` needs this list to prove `.env.example` and the schema did
 * not drift apart.
 */
export const SERVER_ENV_KEYS = Object.keys(fields.shape) as readonly (keyof EnvFields)[];

/** `http://` is fine where there is no network between the browser and the process. */
const isLoopback = (url: string): boolean =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1])(:\d+)?(\/|$)/.test(url);

export const insecureMarkerIn = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : INSECURE_VALUE_MARKERS.find((marker) => value.includes(marker));

/**
 * Cross-field rules and the production preflight, expressed as one `superRefine` so that a single
 * parse reports *every* problem at once. An operator fixing four variables one restart at a time is
 * how a five-minute install turns into an afternoon.
 */
export const serverEnvSchema = fields.superRefine((env: EnvFields, ctx) => {
  if (env.MEILI_HOST !== undefined && env.MEILI_MASTER_KEY === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['MEILI_MASTER_KEY'],
      message: 'MEILI_MASTER_KEY is required when MEILI_HOST is set',
    });
  }

  // Scoped by what is *not* development, not by what is production: `docs/security/threat-model.md`
  // (T-SH-01, T-SH-03) treats every non-development boot as internet-reachable. Checking for
  // `production` alone would let a deployment left on NODE_ENV=test start on a placeholder secret.
  if (env.NODE_ENV === 'development') return;

  for (const key of SECRET_BEARING_ENV_KEYS) {
    const marker = insecureMarkerIn(env[key]);

    if (marker !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} still contains the development placeholder "${marker}". Generate a real secret: openssl rand -base64 32`,
      });
    }
  }

  if (!env.APP_URL.startsWith('https://') && !isLoopback(env.APP_URL)) {
    ctx.addIssue({
      code: 'custom',
      path: ['APP_URL'],
      message:
        'APP_URL must use https in production: session cookies and password reset links travel over it',
    });
  }
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
