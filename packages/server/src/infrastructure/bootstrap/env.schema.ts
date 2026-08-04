import { z } from 'zod';

import { type EnvIssue } from './env.errors.js';

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

/**
 * Long enough that a scraping token is not guessable in the time an unprotected endpoint would be
 * found. Not a password anybody types, so the bar is length rather than composition.
 */
export const METRICS_TOKEN_MIN_LENGTH = 32;

/** Variables that carry a secret, or a connection string containing one. */
export const SECRET_BEARING_ENV_KEYS = [
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_AUTH_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'APP_ENCRYPTION_KEY',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'METRICS_TOKEN',
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

/**
 * A count of proxy hops out of a shell variable.
 *
 * Matched against the digits rather than handed to `z.coerce.number()`, and the difference is the
 * empty string: `Number('')` is `0`, so a coercing schema reads `TRUSTED_PROXY_HOPS=` — a line
 * somebody half-edited — as a deliberate zero. Everything about this variable is a statement about
 * whose word to take for a client's address, and "the operator wrote nothing after the equals sign"
 * is not one of the statements it may make. The fallback is applied inside the transform for the
 * same reason as in `envBoolean`: in Zod 4 a `.default()` short-circuits the pipeline.
 */
const hopCount = (variable: string, fallback: number) =>
  z
    .string()
    .optional()
    .refine((value) => value === undefined || /^\d+$/.test(value), {
      error: `${variable} must be a whole number of proxy hops, zero or more`,
    })
    .transform((value) => (value === undefined ? fallback : Number(value)));

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
  /**
   * The `app_auth` connection: the org-less authentication path, and nothing else.
   *
   * A separate role because it reaches the three resolvers nobody else may call, and a separate
   * *pool* because the connection that opens the org-less path must not be one an ordinary
   * repository can pick up (`docs/security/rls-design.md`, «Особые пути»). The role itself is
   * `NOBYPASSRLS` — the attribute belongs to `app_auth_definer`, the `NOLOGIN` owner the function
   * bodies execute as, so a credential that leaks opens nothing on its own. It holds no table
   * privileges — its whole
   * reachable surface is three `SECURITY DEFINER` functions.
   *
   * `.optional()` for the same reason as `DATABASE_MIGRATION_URL`: turning a variable into a hard
   * requirement stops every existing installation from starting (rules/self-host-packaging.mdc,
   * rule 2). **It is optional in the schema and required in meaning** — the sign-in routes have been
   * in the router since STORY-006-02 — so the absence is announced three times rather than
   * discovered by the first person who tries to sign in:
   *
   *   1. a `warn` line of its own at startup, before the port opens
   *      (`blockingDegradationWarnings`, `api-process.factory.ts`);
   *   2. `authentication: disabled` in the body of `GET /ready`
   *      (`optionalServiceProbes`, `env-features.util.ts`);
   *   3. `503 service_unavailable` naming the variable in `details` on the first use of the
   *      authentication path, instead of the `500 internal_error` a bare `Error` produced
   *      (`detached-database.adapter.ts`).
   *
   * When it *is* set, the role it connects as is verified before the port opens — a URL pointing at
   * `app_migrator` or a superuser would otherwise work perfectly and hand the authentication path
   * write access to every organization (`auth-database.util.ts`).
   */
  DATABASE_AUTH_URL: urlWithScheme(['postgres', 'postgresql'], 'DATABASE_AUTH_URL').optional(),
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

  /**
   * Absent → nothing is sent and mail operations answer `503 mail_not_configured`.
   *
   * Not "written to the log", which this comment used to promise: the one letter the authentication
   * core sends carries a single-use reset token inside its link, and a log is the least private
   * place in a deployment (`rules/observability.mdc`).
   */
  SMTP_URL: urlWithScheme(['smtp', 'smtps'], 'SMTP_URL').optional(),
  /**
   * The mailbox this installation sends from — the SMTP envelope sender, on every message.
   *
   * Required once `SMTP_URL` is set, by the cross-field rule below, and optional otherwise so that
   * an installation with no mail at all is unaffected (`rules/self-host-packaging.mdc`, rule 2).
   * Without it nodemailer sends an empty `MAIL FROM`: Mailpit accepts that — which is why a
   * development setup and the integration suite show nothing wrong — and Postfix, SES and every
   * relay that checks the envelope answer 5.x, so the installation sends no mail at all.
   *
   * A line break is refused outright. The value is written into a message header, and a header
   * value carrying CR or LF is header injection.
   */
  MAIL_FROM: z
    .string()
    .min(1, { error: 'MAIL_FROM must not be empty' })
    .refine((value) => !/[\r\n]/.test(value), {
      error: 'MAIL_FROM must not contain a line break',
    })
    .refine((value) => value.includes('@'), {
      error:
        'MAIL_FROM must be an email address, optionally with a display name: Bad CRM <crm@example.com>',
    })
    .optional(),

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

  /**
   * Off by default, and that is the security decision rather than a taste one.
   *
   * `/metrics` describes the process to anything that can reach it, and an installation that never
   * asked for it should not be publishing one. Turning it on requires `METRICS_TOKEN` — enforced
   * below in `crossFieldEnvIssues`, so «exposed without protection» is not a state this
   * configuration can express.
   */
  METRICS_ENABLED: envBoolean('METRICS_ENABLED', false),
  METRICS_TOKEN: z
    .string()
    .min(
      METRICS_TOKEN_MIN_LENGTH,
      `METRICS_TOKEN must be at least ${String(METRICS_TOKEN_MIN_LENGTH)} characters`,
    )
    .optional(),

  LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: `LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}` })
    .default('info'),
  /** Absent → traces are not exported; logs and metrics keep working. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .url({ error: 'OTEL_EXPORTER_OTLP_ENDPOINT must be a URL' })
    .optional(),

  /** Deliberate exception for the `minimal` profile, never the default (stack.md, `main.ts`). */
  RUN_WORKERS_IN_PROCESS: envBoolean('RUN_WORKERS_IN_PROCESS', false),

  /**
   * How many `X-Forwarded-For` hops in front of this process are the operator's own.
   *
   * **Default `0`, and the default is the security decision.** `X-Forwarded-For` is a request
   * header: anybody who can reach the port writes one. It is evidence only where a proxy the
   * operator runs has appended the real peer, and `docker-compose.yml` ships no proxy at all — the
   * reverse proxy is installed by hand (`docs/runbooks/install.md` §3). On that deployment a value
   * of `1` makes Express take the last entry of a header the *client* wrote, which lands in
   * `sessions.ip_hash` and `sessions.ip_masked` — so the owner of an account reads a network the
   * request never came from, an incident investigation reads values the attacker chose, and the
   * rate limiter gets a fresh budget for every header (`rules/security.mdc` rule 11).
   *
   * Set it to `1` behind exactly one Caddy/nginx/Traefik, and to the number of hops when there are
   * more. Zero means "believe the socket", which is right whenever nothing is in front.
   */
  TRUSTED_PROXY_HOPS: hopCount('TRUSTED_PROXY_HOPS', 0),

  /**
   * Whether this installation still accepts new organizations through `POST /auth/register`.
   *
   * Default `true`, because an installation that has never been registered against cannot be used
   * otherwise — the first door has to be open before anybody can close it. `docs/runbooks/install.md`
   * is where the operator is told to set it to `false` once their organization exists; leaving it
   * open means an anonymous visitor can fill the database (`docs/api/openapi.yaml`,
   * `RegistrationDisabled`).
   */
  REGISTRATION_OPEN: envBoolean('REGISTRATION_OPEN', true),

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
 * Cross-field rules and the production preflight, as a pure function over whatever fields parsed.
 *
 * It takes a `Partial` on purpose. In Zod 4 an object check is skipped when a field failed
 * **fatally** — a wrong enum value, a failed coercion — while a non-fatal failure (`min`, `refine`)
 * still lets it run. Measured, not assumed: `PORT=abc` together with a plaintext `APP_URL` in
 * production reported only `PORT`, so the operator fixed it, restarted, and only then learned about
 * the second problem. `load-env.util.ts` therefore runs these rules a second time over the fields
 * that did parse and merges both lists, and this function has to tolerate the ones that did not.
 */
export const crossFieldEnvIssues = (env: Partial<EnvFields>): EnvIssue[] => {
  const issues: EnvIssue[] = [];

  if (env.MEILI_HOST !== undefined && env.MEILI_MASTER_KEY === undefined) {
    issues.push({
      variable: 'MEILI_MASTER_KEY',
      message: 'MEILI_MASTER_KEY is required when MEILI_HOST is set',
    });
  }

  if (env.METRICS_ENABLED === true && env.METRICS_TOKEN === undefined) {
    issues.push({
      variable: 'METRICS_TOKEN',
      message: 'METRICS_TOKEN is required when METRICS_ENABLED is true',
    });
  }

  // `MAIL_FROM` is deliberately **not** here, and the first version of this delta had it.
  //
  // Tying it to `SMTP_URL` looked like the careful choice — demand it only of installations that
  // would otherwise send nothing — but `SMTP_URL` has been in `.env.example` since EPIC-001 and in
  // every development environment built from it, while `MAIL_FROM` is new. So the rule refused to
  // start every installation that already existed.
  //
  // `rules/self-host-packaging.mdc` rule 2 says how this is done instead: release N warns, release
  // N+1 refuses. The warning is a blocking degradation in `env-features.util.ts`, the same mechanism
  // `DATABASE_AUTH_URL` uses two variables above.
  //
  // Removing the rule from here was not enough on its own, and that is worth writing down: the
  // mailer *also* threw on the same condition, `buildContainer` calls it before any degradation is
  // printed, and so the process still exited before opening the port while this comment described a
  // warning. Two gates, one of them invisible from here. `mail.factory.ts` now returns the
  // unconfigured mailer instead, so mail is disabled rather than fatal and the `warn` above is
  // reachable; the hard requirement belongs to the release that mounts mail in the container.

  // Scoped by what is *not* development, not by what is production: `docs/security/threat-model.md`
  // (T-SH-01, T-SH-03) treats every non-development boot as internet-reachable. Checking for
  // `production` alone would let a deployment left on NODE_ENV=test start on a placeholder secret.
  //
  // An unreadable NODE_ENV skips the preflight rather than assuming a mode: telling an operator who
  // meant `development` that their placeholder secret is unacceptable would be wrong advice, and
  // the issue naming NODE_ENV is already in the list.
  if (env.NODE_ENV === undefined || env.NODE_ENV === 'development') return issues;

  for (const key of SECRET_BEARING_ENV_KEYS) {
    const marker = insecureMarkerIn(env[key]);

    if (marker !== undefined) {
      issues.push({
        variable: key,
        message: `${key} still contains the development placeholder "${marker}". Generate a real secret: openssl rand -base64 32`,
      });
    }
  }

  if (
    env.APP_URL !== undefined &&
    !env.APP_URL.startsWith('https://') &&
    !isLoopback(env.APP_URL)
  ) {
    issues.push({
      variable: 'APP_URL',
      message:
        'APP_URL must use https in production: session cookies and password reset links travel over it',
    });
  }

  return issues;
};

/**
 * Field-by-field parse, keeping only what succeeded.
 *
 * The input for the second pass over the cross-field rules: a whole-object parse gives back nothing
 * when one field fails, and the rules still have something to say about the fields that were fine.
 */
export const parseKnownEnvFields = (
  source: Record<string, string | undefined>,
): Partial<EnvFields> =>
  Object.fromEntries(
    Object.entries(fields.shape).flatMap(([key, schema]) => {
      const parsed = schema.safeParse(source[key]);

      return parsed.success && parsed.data !== undefined ? [[key, parsed.data]] : [];
    }),
  );

/** Fields plus the cross-field rules. `loadEnv` is the entry point that also merges both passes. */
export const serverEnvSchema = fields.superRefine((env: EnvFields, ctx) => {
  for (const issue of crossFieldEnvIssues(env)) {
    ctx.addIssue({ code: 'custom', path: [issue.variable], message: issue.message });
  }
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
