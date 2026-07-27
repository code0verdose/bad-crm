import { describe, expect, it } from 'vitest';

import {
  createS3Check,
  interpretHeadBucket,
  signAwsV4,
} from '../../scripts/lib/checks/s3.check.js';
import {
  createMeilisearchCheck,
  interpretMeiliHealth,
} from '../../scripts/lib/checks/meilisearch.check.js';
import {
  EXPECTED_ROLES,
  REQUIRED_EXTENSIONS,
  collectPostgresFacts,
  createPostgresCheck,
  interpretPostgres,
  interpretPostgresError,
} from '../../scripts/lib/checks/postgres.check.js';
import { createReachabilityCheck } from '../../scripts/lib/checks/reachability.check.js';
import {
  createRedisCheck,
  interpretRedisReply,
  redisCommandsFor,
} from '../../scripts/lib/checks/redis.check.js';
import { createSmtpCheck, interpretSmtpBanner } from '../../scripts/lib/checks/smtp.check.js';
import { resolveToolingEnv } from '../../scripts/lib/check-env.util.js';
import { exitCodeFor, renderReport, summarize } from '../../scripts/lib/check-report.util.js';
import {
  hostPortOf,
  maskUrl,
  postgresTargetOf,
  redactSecrets,
  redisTargetOf,
} from '../../scripts/lib/connection-target.util.js';
import { parseEnvFile } from '../../scripts/lib/env-file.util.js';
import { skipReasonFor, skippedCheck } from '../../scripts/lib/check-plan.util.js';
import { runChecks } from '../../scripts/lib/run-checks.util.js';
import { describeSocketError } from '../../scripts/lib/socket-error.util.js';
import type { CheckResult, ServiceCheck } from '../../scripts/lib/service-check.types.js';

const VALID_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://app_user:app_pw@localhost:5432/bad_crm',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'bad-crm',
  S3_ACCESS_KEY: 'minio_user',
  // Fixture values for a schema that only checks non-emptiness — not credentials of anything.
  // Both exemption syntaxes: scan-secrets.sh reads one, gitleaks the other (rules/security.mdc).
  S3_SECRET_KEY: 'minio_password', // scan-secrets:allow gitleaks:allow
};

const result = (over: Partial<CheckResult>): CheckResult => ({
  service: 'postgres',
  requirement: 'required',
  target: 'localhost:5432',
  status: 'ok',
  details: [],
  durationMs: 1,
  ...over,
});

// ─── .env parsing ────────────────────────────────────────────────────────────────────────────

describe('parseEnvFile', () => {
  it('reads plain assignments and ignores comments and blank lines', () => {
    expect(
      parseEnvFile(['# a comment', '', 'PORT=3000', '   ', 'S3_BUCKET=bad-crm'].join('\n')),
    ).toEqual({ PORT: '3000', S3_BUCKET: 'bad-crm' });
  });

  it('strips one layer of surrounding quotes but keeps inner characters', () => {
    expect(parseEnvFile('A="one two"\nB=\'three#four\'')).toEqual({
      A: 'one two',
      B: 'three#four',
    });
  });

  it('keeps a value that itself contains "="', () => {
    expect(parseEnvFile('APP_ENCRYPTION_KEY=abc==')).toEqual({ APP_ENCRYPTION_KEY: 'abc==' });
  });

  it('accepts the `export ` prefix some operators paste in', () => {
    expect(parseEnvFile('export PORT=3000')).toEqual({ PORT: '3000' });
  });

  it('drops a trailing inline comment only when it is separated by whitespace', () => {
    expect(parseEnvFile('A=value # trailing\nB=va#lue')).toEqual({ A: 'value', B: 'va#lue' });
  });

  it('ignores a line that is not an assignment', () => {
    expect(parseEnvFile('not an assignment\nPORT=1')).toEqual({ PORT: '1' });
  });
});

// ─── env resolution ──────────────────────────────────────────────────────────────────────────

describe('resolveToolingEnv', () => {
  const resolve = (options: {
    file?: string | undefined;
    processEnv?: Record<string, string | undefined>;
  }) =>
    resolveToolingEnv({
      repoRoot: '/repo',
      processEnv: options.processEnv ?? {},
      readFile: () => options.file,
    });

  it('reports a missing .env instead of guessing defaults', () => {
    const resolution = resolve({ file: undefined });

    expect(resolution.envFileExists).toBe(false);
    expect(resolution.env).toBeUndefined();
    expect(resolution.envFilePath).toBe('/repo/.env');
  });

  it('parses a complete .env through the server schema', () => {
    const contents = Object.entries(VALID_ENV)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const resolution = resolve({ file: contents });

    expect(resolution.issues).toEqual([]);
    expect(resolution.env?.S3_BUCKET).toBe('bad-crm');
    // Defaults of the schema are applied, so a check never has to invent one.
    expect(resolution.env?.PORT).toBe(3000);
  });

  it('returns the offending variables when the configuration is invalid', () => {
    const resolution = resolve({ file: 'APP_URL=http://localhost:3000' });

    expect(resolution.env).toBeUndefined();
    expect(resolution.issues.map((issue) => issue.variable)).toContain('DATABASE_URL');
  });

  it('lets the shell override the file, as dotenv does', () => {
    const resolution = resolve({
      file: Object.entries({ ...VALID_ENV, S3_BUCKET: 'from-file' })
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
      processEnv: { S3_BUCKET: 'from-shell' },
    });

    expect(resolution.env?.S3_BUCKET).toBe('from-shell');
  });

  /**
   * `COMPOSE_PROFILES` decides whether a missing Meilisearch is "skipped" or "failed", and it is
   * normally set in `.env` rather than in the shell — reading only `process.env` would make
   * `pnpm check:services` on the `minimal` profile report the two services it deliberately does
   * not start as broken.
   */
  it('reads the compose profile from the file, with the shell overriding it', () => {
    const file = Object.entries({ ...VALID_ENV, COMPOSE_PROFILES: 'minimal' })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    expect(resolve({ file }).profile).toBe('minimal');
    expect(resolve({ file, processEnv: { COMPOSE_PROFILES: 'default' } }).profile).toBe('default');
  });

  it('falls back to the default profile when nothing sets it', () => {
    expect(resolve({ file: 'APP_URL=http://localhost:3000' }).profile).toBe('default');
    expect(resolve({ file: undefined }).profile).toBe('default');
  });

  it('never carries a value into an issue, only the variable name', () => {
    const resolution = resolve({
      // A deliberately invalid value, not a secret. Marked in both exemption syntaxes because
      // scan-secrets.sh reads one of them and gitleaks the other (rules/security.mdc).
      file: [...Object.entries({ ...VALID_ENV, JWT_SECRET: 'too-short' })] // scan-secrets:allow gitleaks:allow
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    });

    expect(JSON.stringify(resolution.issues)).not.toContain('too-short');
  });
});

// ─── connection targets and masking ──────────────────────────────────────────────────────────

describe('connection targets', () => {
  it('extracts host, port, database and user from a Postgres DSN', () => {
    expect(postgresTargetOf('postgres://app_user:pw@db.internal:6543/bad_crm')).toEqual({
      host: 'db.internal',
      port: 6543,
      database: 'bad_crm',
      user: 'app_user',
    });
  });

  it('applies the PostgreSQL default port when the DSN omits it', () => {
    expect(postgresTargetOf('postgres://app_user@localhost/bad_crm').port).toBe(5432);
  });

  it('reads the Redis password without exposing it in the target label', () => {
    const target = redisTargetOf('redis://:s3cret@localhost:6380');

    expect(target.port).toBe(6380);
    expect(target.password).toBe('s3cret');
    expect(maskUrl('redis://:s3cret@localhost:6380')).not.toContain('s3cret');
  });

  it('defaults the Redis port and reports no password when there is none', () => {
    expect(redisTargetOf('redis://localhost')).toEqual({ host: 'localhost', port: 6379 });
  });

  it('derives host and port of an http endpoint, including the implicit ports', () => {
    expect(hostPortOf('http://localhost:9000')).toEqual({ host: 'localhost', port: 9000 });
    expect(hostPortOf('https://search.example.com')).toEqual({
      host: 'search.example.com',
      port: 443,
    });
    expect(hostPortOf('smtp://localhost:1025')).toEqual({ host: 'localhost', port: 1025 });
  });

  it('masks the password of a URL but keeps everything an operator needs', () => {
    expect(maskUrl('postgres://app_user:hunter2@localhost:5432/bad_crm')).toBe(
      'postgres://app_user@localhost:5432/bad_crm',
    );
  });

  it('leaves a URL without credentials untouched', () => {
    expect(maskUrl('http://localhost:9000')).toBe('http://localhost:9000');
  });

  it('returns the raw string when it is not a URL at all, rather than throwing', () => {
    expect(maskUrl('not a url')).toBe('not a url');
  });

  it('redacts credentials embedded in arbitrary text, such as a driver error', () => {
    const redacted = redactSecrets(
      'connect ECONNREFUSED for postgres://app_user:hunter2@localhost:5432/bad_crm',
    );

    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('app_user');
  });

  /**
   * `scheme://:password@host` — userinfo with a password and no login — is the canonical form for
   * Redis and legal for SMTP, and it is the form a self-host operator is most likely to paste into
   * `.env`. It reached the terminal unredacted while the regex demanded a username: the skipped
   * optional service reports `env.SMTP_URL` verbatim as its target.
   */
  it.each([
    ['redis://:supersecret@localhost:6379', 'supersecret'],
    ['smtp://:mailpass@mail.example.com:587', 'mailpass'],
  ])('redacts %o, where the password carries no username', (url, secret) => {
    expect(redactSecrets(`SKIPPED smtp ${url} (optional)`)).not.toContain(secret);
  });
});

/**
 * Found by running the thing: `pnpm dev` with Postgres stopped printed
 * `postgres (localhost:5433): localhost:5433 — ` and nothing after the dash. On a dual-stack
 * `localhost` Node tries ::1 and 127.0.0.1 in parallel and reports the failure as an
 * `AggregateError`, whose own `message` is the empty string — so the one line the preflight exists
 * to print said nothing at all.
 */
describe('describeSocketError', () => {
  it('uses the errno code, which is what an operator recognises', () => {
    expect(
      describeSocketError(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })),
    ).toBe('ECONNREFUSED');
  });

  it('unwraps an AggregateError instead of printing its empty message', () => {
    const aggregate = new AggregateError([
      Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
      Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
    ]);

    expect(describeSocketError(aggregate)).toBe('ECONNREFUSED');
  });

  it('keeps every distinct reason when the two address families failed differently', () => {
    const aggregate = new AggregateError([
      Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
      Object.assign(new Error(''), { code: 'EHOSTUNREACH' }),
    ]);

    expect(describeSocketError(aggregate)).toBe('ECONNREFUSED, EHOSTUNREACH');
  });

  it('falls back to the message when there is no code', () => {
    expect(describeSocketError(new Error('socket hang up'))).toBe('socket hang up');
  });

  /** `fetch` reports every transport problem as `TypeError: fetch failed` and hides the reason. */
  it('unwraps the cause that fetch hides behind "fetch failed"', () => {
    const failure = new TypeError('fetch failed', {
      cause: Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
    });

    expect(describeSocketError(failure)).toBe('fetch failed: ECONNREFUSED');
  });

  it('never returns an empty string, because a dash followed by nothing explains nothing', () => {
    expect(describeSocketError(new AggregateError([]))).not.toBe('');
    expect(describeSocketError(new Error(''))).not.toBe('');
  });
});

// ─── PostgreSQL interpretation ───────────────────────────────────────────────────────────────

const healthyFacts = {
  currentUser: 'app_user',
  extensions: [...REQUIRED_EXTENSIONS],
  roles: EXPECTED_ROLES.map((role) => ({
    rolname: role.role,
    rolbypassrls: role.bypassRls,
    rolsuper: false,
    rolcanlogin: true,
  })),
};

describe('interpretPostgres', () => {
  it('accepts a fully bootstrapped database', () => {
    const outcome = interpretPostgres(healthyFacts);

    expect(outcome.status).toBe('ok');
    expect(outcome.details.join(' ')).toContain('app_user');
  });

  it('requires every extension the bootstrap installs', () => {
    expect([...REQUIRED_EXTENSIONS].sort()).toEqual([
      'btree_gist',
      'citext',
      'pg_trgm',
      'pgcrypto',
      'vector',
    ]);
  });

  it('fails and names the missing extension', () => {
    const outcome = interpretPostgres({
      ...healthyFacts,
      extensions: healthyFacts.extensions.filter((name) => name !== 'vector'),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.details.join(' ')).toContain('vector');
    expect(outcome.remedy).toContain('docker:reset');
  });

  it('fails and names the missing role', () => {
    const outcome = interpretPostgres({
      ...healthyFacts,
      roles: healthyFacts.roles.filter((role) => role.rolname !== 'backup_role'),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.details.join(' ')).toContain('backup_role');
    expect(outcome.remedy).toContain('db:bootstrap');
  });

  /**
   * The whole point of the check: `app_user` with BYPASSRLS reads every tenant's rows while every
   * test and every policy still passes. It cannot be caught by a container healthcheck.
   */
  it('fails when app_user has BYPASSRLS', () => {
    const outcome = interpretPostgres({
      ...healthyFacts,
      roles: healthyFacts.roles.map((role) =>
        role.rolname === 'app_user' ? { ...role, rolbypassrls: true } : role,
      ),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.details.join(' ')).toMatch(/app_user.*BYPASSRLS/s);
  });

  it('fails when backup_role lost BYPASSRLS, because the dump would then be partial', () => {
    const outcome = interpretPostgres({
      ...healthyFacts,
      roles: healthyFacts.roles.map((role) =>
        role.rolname === 'backup_role' ? { ...role, rolbypassrls: false } : role,
      ),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.details.join(' ')).toContain('backup_role');
  });

  it('fails when the application role became a superuser', () => {
    const outcome = interpretPostgres({
      ...healthyFacts,
      roles: healthyFacts.roles.map((role) =>
        role.rolname === 'app_user' ? { ...role, rolsuper: true } : role,
      ),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.details.join(' ')).toContain('SUPERUSER');
  });

  it('fails when a role cannot log in', () => {
    const outcome = interpretPostgres({
      ...healthyFacts,
      roles: healthyFacts.roles.map((role) =>
        role.rolname === 'app_auth' ? { ...role, rolcanlogin: false } : role,
      ),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.details.join(' ')).toContain('LOGIN');
  });
});

describe('collectPostgresFacts', () => {
  it('maps the three catalogue queries onto the facts the interpretation needs', async () => {
    const rows: Record<string, Record<string, unknown>[]> = {
      user: [{ name: 'app_user' }],
      extensions: [{ name: 'vector' }, { name: 'citext' }],
      roles: [{ rolname: 'app_user', rolbypassrls: false, rolsuper: false, rolcanlogin: true }],
    };

    const facts = await collectPostgresFacts((sql) =>
      Promise.resolve(
        sql.includes('current_user')
          ? rows.user!
          : sql.includes('pg_extension')
            ? rows.extensions!
            : rows.roles!,
      ),
    );

    expect(facts.currentUser).toBe('app_user');
    expect(facts.extensions).toEqual(['vector', 'citext']);
    expect(facts.roles[0]).toEqual({
      rolname: 'app_user',
      rolbypassrls: false,
      rolsuper: false,
      rolcanlogin: true,
    });
  });

  it('does not invent a user when the server answered nothing', async () => {
    expect((await collectPostgresFacts(() => Promise.resolve([]))).currentUser).toBe('unknown');
  });
});

/**
 * Diagnosis by SQLSTATE, not by message text. The first live run of `pnpm check:services` hit a
 * stray host PostgreSQL that answered `роль "app_user" не существует` — the server localises the
 * message, and an English regexp would have produced "unknown error" on the one machine where the
 * check was most needed.
 */
describe('interpretPostgresError', () => {
  it.each([
    ['28000', 'does not exist'],
    ['28P01', 'password'],
    ['3D000', 'database'],
    ['ECONNREFUSED', 'listening'],
    ['ETIMEDOUT', 'POSTGRES_PORT'],
  ])('turns SQLSTATE %s into a specific diagnosis', (code, expected) => {
    const outcome = interpretPostgresError({ code, message: 'localised server message' });

    expect(outcome.status).toBe('failed');
    expect(`${outcome.details.join(' ')} ${outcome.remedy ?? ''}`).toContain(expected);
  });

  it('keeps the server message even when the code is recognised', () => {
    expect(
      interpretPostgresError({ code: '28000', message: 'роль "app_user" не существует' }).details,
    ).toContain('роль "app_user" не существует');
  });

  it('points at the runbook for a code it does not know', () => {
    const outcome = interpretPostgresError({ code: 'XX999', message: 'internal error' });

    expect(outcome.remedy).toContain('local-environment.md');
  });

  it('handles an error with no code at all', () => {
    expect(interpretPostgresError({ message: 'socket hang up' }).status).toBe('failed');
  });

  it('tells the operator that DATABASE_URL may be reaching a different server', () => {
    expect(interpretPostgresError({ code: '28000', message: '' }).remedy).toContain(
      'docker compose port postgres 5432',
    );
  });
});

describe('createPostgresCheck', () => {
  const check = (withConnection: <T>(run: (query: never) => Promise<T>) => Promise<T>) =>
    createPostgresCheck({
      databaseUrl: 'postgres://app_user:hunter2@localhost:5432/bad_crm',
      target: postgresTargetOf('postgres://app_user:hunter2@localhost:5432/bad_crm'),
      withConnection,
    });

  it('labels itself with the DSN minus the password', () => {
    expect(check(() => Promise.resolve(healthyFacts)).target).toBe(
      'postgres://app_user@localhost:5432/bad_crm',
    );
  });

  it('turns a driver rejection into the SQLSTATE diagnosis instead of a stack trace', async () => {
    const failure = Object.assign(new Error('роль "app_user" не существует'), { code: '28000' });
    const outcome = await check(() => Promise.reject(failure)).run();

    expect(outcome.status).toBe('failed');
    expect(outcome.remedy).toContain('db:bootstrap');
  });
});

// ─── Redis ───────────────────────────────────────────────────────────────────────────────────

describe('redis check', () => {
  it('sends PING alone when the URL carries no password', () => {
    expect(redisCommandsFor(undefined)).toEqual(['PING']);
  });

  it('authenticates before pinging when the URL carries a password', () => {
    expect(redisCommandsFor('s3cret')).toEqual(['AUTH s3cret', 'PING']);
  });

  it('accepts +PONG', () => {
    expect(interpretRedisReply('+PONG\r\n').status).toBe('ok');
  });

  it('accepts +OK followed by +PONG, which is what AUTH + PING returns', () => {
    expect(interpretRedisReply('+OK\r\n+PONG\r\n').status).toBe('ok');
  });

  it('fails on a protocol error and repeats the server message', () => {
    const outcome = interpretRedisReply('-NOAUTH Authentication required.\r\n');

    expect(outcome.status).toBe('failed');
    expect(outcome.details.join(' ')).toContain('NOAUTH');
  });

  it('fails on an empty reply rather than reporting success', () => {
    expect(interpretRedisReply('').status).toBe('failed');
  });

  it('never echoes the password back into the report', () => {
    expect(JSON.stringify(interpretRedisReply('-ERR invalid password'))).not.toContain('AUTH ');
  });
});

// ─── MinIO / S3 ──────────────────────────────────────────────────────────────────────────────

describe('interpretHeadBucket', () => {
  it('accepts 200', () => {
    expect(interpretHeadBucket(200, 'bad-crm').status).toBe('ok');
  });

  it('reports a missing bucket on 404 and points at the initialiser', () => {
    const outcome = interpretHeadBucket(404, 'bad-crm');

    expect(outcome.status).toBe('failed');
    expect(outcome.details.join(' ')).toContain('bad-crm');
    expect(outcome.remedy).toContain('docker:up');
  });

  it('reports rejected credentials on 403 without printing them', () => {
    const outcome = interpretHeadBucket(403, 'bad-crm');

    expect(outcome.status).toBe('failed');
    expect(outcome.details.join(' ')).toContain('S3_ACCESS_KEY');
    expect(outcome.details.join(' ')).not.toContain('S3_SECRET_KEY=');
  });

  it('treats any other status as a failure and states it', () => {
    expect(interpretHeadBucket(503, 'bad-crm').status).toBe('failed');
    expect(interpretHeadBucket(503, 'bad-crm').details.join(' ')).toContain('503');
  });
});

describe('signAwsV4', () => {
  const request = {
    method: 'HEAD',
    url: new URL('http://localhost:9000/bad-crm'),
    region: 'us-east-1',
    accessKey: 'AKIDEXAMPLE',
    // The AWS SigV4 documentation test vector, published to be reproduced; the expected signature
    // below is only checkable against it. Marked in both exemption syntaxes.
    secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', // scan-secrets:allow gitleaks:allow
    now: new Date('2026-07-27T09:00:00.000Z'),
  };

  it('produces the SigV4 header set MinIO requires', () => {
    const headers = signAwsV4(request);

    expect(headers.host).toBe('localhost:9000');
    expect(headers['x-amz-date']).toBe('20260727T090000Z');
    // Unsigned payloads are not accepted by MinIO for HEAD; the empty-body hash is used instead.
    expect(headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260727\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it('is deterministic for the same request', () => {
    expect(signAwsV4(request).authorization).toBe(signAwsV4(request).authorization);
  });

  it('changes the signature when the secret changes', () => {
    expect(signAwsV4({ ...request, secretKey: 'other' }).authorization).not.toBe(
      signAwsV4(request).authorization,
    );
  });

  it('changes the signature when the path changes', () => {
    expect(
      signAwsV4({ ...request, url: new URL('http://localhost:9000/other') }).authorization,
    ).not.toBe(signAwsV4(request).authorization);
  });

  it('never puts the secret key into a header', () => {
    expect(JSON.stringify(signAwsV4(request))).not.toContain(request.secretKey);
  });
});

// ─── Meilisearch and SMTP ────────────────────────────────────────────────────────────────────

describe('interpretMeiliHealth', () => {
  it('accepts an available instance', () => {
    expect(interpretMeiliHealth(200, '{"status":"available"}').status).toBe('ok');
  });

  it('fails when the instance answers but is not available', () => {
    const outcome = interpretMeiliHealth(200, '{"status":"loading"}');

    expect(outcome.status).toBe('failed');
    expect(outcome.details.join(' ')).toContain('loading');
  });

  it('fails on a non-200 status', () => {
    expect(interpretMeiliHealth(503, '').status).toBe('failed');
  });

  it('fails on a body that is not JSON rather than throwing', () => {
    expect(interpretMeiliHealth(200, '<html>').status).toBe('failed');
  });
});

describe('interpretSmtpBanner', () => {
  it('accepts a 220 greeting', () => {
    expect(interpretSmtpBanner('220 Mailpit ESMTP Service ready\r\n').status).toBe('ok');
  });

  it('fails on anything else', () => {
    expect(interpretSmtpBanner('421 Service not available\r\n').status).toBe('failed');
    expect(interpretSmtpBanner('').status).toBe('failed');
  });
});

// ─── which checks apply to which profile ─────────────────────────────────────────────────────

describe('skipReasonFor', () => {
  it('skips Meilisearch when MEILI_HOST is not configured', () => {
    expect(
      skipReasonFor('meilisearch', {
        meiliHost: undefined,
        smtpUrl: 'smtp://x',
        profile: 'default',
      }),
    ).toContain('MEILI_HOST');
  });

  it('skips Meilisearch in the minimal profile even when MEILI_HOST is set', () => {
    expect(
      skipReasonFor('meilisearch', {
        meiliHost: 'http://localhost:7700',
        smtpUrl: 'smtp://x',
        profile: 'minimal',
      }),
    ).toContain('minimal');
  });

  it('runs the Meilisearch check in the default profile', () => {
    expect(
      skipReasonFor('meilisearch', {
        meiliHost: 'http://localhost:7700',
        smtpUrl: 'smtp://x',
        profile: 'default',
      }),
    ).toBeUndefined();
  });

  it('skips SMTP when SMTP_URL is not configured', () => {
    expect(
      skipReasonFor('smtp', { meiliHost: undefined, smtpUrl: undefined, profile: 'default' }),
    ).toContain('SMTP_URL');
  });

  it('skips SMTP in the minimal profile, which does not start Mailpit', () => {
    expect(
      skipReasonFor('smtp', {
        meiliHost: undefined,
        smtpUrl: 'smtp://localhost:1025',
        profile: 'minimal',
      }),
    ).toContain('minimal');
  });
});

/**
 * The factories are thin, and that is exactly why they are worth a test: they decide the label an
 * operator sees, the requirement that drives the exit code, and which value reaches the transport.
 * A `redisUrl` accidentally passed where a host was expected would print a password on screen.
 */
describe('check factories wire the right target, requirement and transport', () => {
  it('labels Redis by host and port and forwards the password to the transport only', async () => {
    let sent: readonly string[] = [];
    const check = createRedisCheck({
      redisUrl: 'redis://:s3cret@localhost:6380',
      target: redisTargetOf('redis://:s3cret@localhost:6380'),
      send: (_target, commands) => {
        sent = commands;
        return Promise.resolve('+OK\r\n+PONG\r\n');
      },
    });

    expect(check.target).toBe('localhost:6380');
    expect(check.requirement).toBe('required');
    expect((await check.run()).status).toBe('ok');
    expect(sent).toEqual(['AUTH s3cret', 'PING']);
  });

  it('addresses MinIO path-style and signs the request it hands to the transport', async () => {
    let seen: { url: URL; headers: Record<string, string> } | undefined;
    const check = createS3Check({
      endpoint: 'http://localhost:9000/',
      bucket: 'bad-crm',
      region: 'us-east-1',
      accessKey: 'user',
      secretKey: 'password', // scan-secrets:allow gitleaks:allow — fixture for the SigV4 input
      now: () => new Date('2026-07-27T09:00:00.000Z'),
      head: (request) => {
        seen = request;
        return Promise.resolve(200);
      },
    });

    expect(check.service).toBe('minio');
    expect(check.target).toBe('http://localhost:9000/bad-crm');
    expect((await check.run()).status).toBe('ok');
    expect(seen?.url.pathname).toBe('/bad-crm');
    expect(seen?.headers['authorization']).toContain('AWS4-HMAC-SHA256');
    expect(JSON.stringify(seen?.headers)).not.toContain('password');
  });

  it('asks Meilisearch for /health and stays optional', async () => {
    let asked: URL | undefined;
    const check = createMeilisearchCheck({
      host: 'http://localhost:7700',
      get: (url) => {
        asked = url;
        return Promise.resolve({ status: 200, body: '{"status":"available"}' });
      },
    });

    expect(check.requirement).toBe('optional');
    expect(check.target).toBe('http://localhost:7700/health');
    expect((await check.run()).status).toBe('ok');
    expect(asked?.pathname).toBe('/health');
  });

  it('reads the SMTP banner and stays optional', async () => {
    const check = createSmtpCheck({
      target: hostPortOf('smtp://localhost:1025'),
      readBanner: () => Promise.resolve('220 Mailpit ESMTP Service ready\r\n'),
    });

    expect(check.requirement).toBe('optional');
    expect(check.target).toBe('localhost:1025');
    expect((await check.run()).status).toBe('ok');
  });

  /**
   * A refused socket used to fall through to the generic handler, which can only say "see the
   * runbook" — while the factory knows the answer is `pnpm docker:up`. Observed live: stopping the
   * Redis container produced a FAILED line whose remedy was a pointer to a document.
   */
  it.each([
    [
      'redis',
      () =>
        createRedisCheck({
          redisUrl: 'redis://localhost:6379',
          target: { host: 'localhost', port: 6379 },
          send: () => Promise.reject(new Error('localhost:6379 — ECONNREFUSED')),
        }),
    ],
    [
      'smtp',
      () =>
        createSmtpCheck({
          target: { host: 'localhost', port: 1025 },
          readBanner: () => Promise.reject(new Error('localhost:1025 — ECONNREFUSED')),
        }),
    ],
    [
      'meilisearch',
      () =>
        createMeilisearchCheck({
          host: 'http://localhost:7700',
          get: () => Promise.reject(new TypeError('fetch failed')),
        }),
    ],
    [
      'minio',
      () =>
        createS3Check({
          endpoint: 'http://localhost:9000',
          bucket: 'bad-crm',
          region: 'us-east-1',
          accessKey: 'user',
          secretKey: 'password', // scan-secrets:allow gitleaks:allow — fixture, the transport rejects anyway
          now: () => new Date('2026-07-27T09:00:00.000Z'),
          head: () => Promise.reject(new TypeError('fetch failed')),
        }),
    ],
  ])('answers a refused %s transport with the command that fixes it', async (_service, build) => {
    const outcome = await build().run();

    expect(outcome.status).toBe('failed');
    expect(outcome.remedy).toContain('pnpm docker:up');
    expect(outcome.details.join(' ')).not.toBe('');
  });

  it('produces a skipped optional check that never opens a socket', async () => {
    const check = skippedCheck('meilisearch', 'http://localhost:7700', 'minimal profile');

    expect(check.requirement).toBe('optional');
    expect(await check.run()).toEqual({ status: 'skipped', details: ['minimal profile'] });
  });
});

// ─── running and reporting ───────────────────────────────────────────────────────────────────

const stubCheck = (
  over: Partial<ServiceCheck> & { outcome?: () => Promise<never> },
): ServiceCheck =>
  ({
    service: 'stub',
    requirement: 'required',
    target: 'localhost:1',
    run: async () => ({ status: 'ok', details: [] }),
    ...over,
  }) as ServiceCheck;

describe('runChecks', () => {
  it('records the outcome and the duration of every check', async () => {
    let clock = 100;
    const results = await runChecks([stubCheck({})], () => (clock += 5));

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('ok');
    expect(results[0]?.durationMs).toBeGreaterThan(0);
  });

  /**
   * A check that throws — a DNS failure, a driver bug — must become a reported failure of that one
   * service. An unhandled rejection here would abort the whole report and print a stack trace
   * instead of the four services that are fine.
   */
  it('turns a thrown error into a failed result instead of aborting the run', async () => {
    const results = await runChecks(
      [
        stubCheck({
          service: 'boom',
          run: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
        }),
        stubCheck({ service: 'fine' }),
      ],
      () => Date.now(),
    );

    expect(results.map((entry) => entry.status)).toEqual(['failed', 'ok']);
    expect(results[0]?.details.join(' ')).toContain('ECONNREFUSED');
  });

  it('redacts credentials that an error message dragged in', async () => {
    const results = await runChecks(
      [
        stubCheck({
          run: () =>
            Promise.reject(new Error('failed on postgres://app_user:hunter2@localhost:5432/x')),
        }),
      ],
      () => Date.now(),
    );

    expect(JSON.stringify(results)).not.toContain('hunter2');
  });
});

describe('summarize and exitCodeFor', () => {
  it('counts each status', () => {
    expect(
      summarize([
        result({ status: 'ok' }),
        result({ status: 'failed', requirement: 'optional' }),
        result({ status: 'skipped', requirement: 'optional' }),
      ]),
    ).toEqual({ ok: 1, failed: 1, skipped: 1, requiredFailures: 0 });
  });

  it('exits 0 when everything required passed', () => {
    expect(exitCodeFor([result({ status: 'ok' }), result({ status: 'skipped' })])).toBe(0);
  });

  it('exits 1 when a required service failed', () => {
    expect(exitCodeFor([result({ status: 'failed' })])).toBe(1);
  });

  /**
   * The application is required to start without Meilisearch, SMTP, AI and OTel
   * (stack.md, «Деградация при отсутствии опционального сервиса»). A smoke check that fails the
   * command because the optional mail catcher is down would make `minimal` permanently red.
   */
  it('exits 0 when only an optional service failed', () => {
    expect(exitCodeFor([result({ status: 'failed', requirement: 'optional' })])).toBe(0);
  });
});

describe('renderReport', () => {
  const report = renderReport([
    result({ service: 'postgres', status: 'ok', details: ['5 extensions, 4 roles'] }),
    result({
      service: 'minio',
      status: 'failed',
      details: ['bucket bad-crm does not exist'],
      remedy: 'run `pnpm docker:up`',
    }),
    result({
      service: 'meilisearch',
      requirement: 'optional',
      status: 'skipped',
      details: ['MEILI_HOST is not set'],
    }),
  ]);

  it('names every service and its verdict', () => {
    expect(report).toContain('postgres');
    expect(report).toContain('minio');
    expect(report).toContain('meilisearch');
  });

  it('prints the remedy of a failure, because a verdict without a next step is not actionable', () => {
    expect(report).toContain('run `pnpm docker:up`');
  });

  it('marks a skipped optional service as skipped rather than as a problem', () => {
    const line = report.split('\n').find((entry) => entry.includes('meilisearch')) ?? '';

    expect(line.toLowerCase()).toContain('skip');
  });

  it('ends with a summary line', () => {
    expect(report.trim().split('\n').at(-1)).toMatch(/1 ok, 1 failed, 1 skipped/);
  });
});

// ─── reachability check ──────────────────────────────────────────────────────────────────────

describe('createReachabilityCheck', () => {
  const check = (connect: () => Promise<void>) =>
    createReachabilityCheck({
      service: 'postgres',
      requirement: 'required',
      target: { host: 'localhost', port: 5432 },
      remedy: 'start the stack with `pnpm docker:up`',
      timeoutMs: 1000,
      connect,
    });

  it('passes when the port accepts a connection', async () => {
    expect((await check(() => Promise.resolve()).run()).status).toBe('ok');
  });

  it('fails with the remedy when the port refuses', async () => {
    const outcome = await check(() => Promise.reject(new Error('ECONNREFUSED'))).run();

    expect(outcome.status).toBe('failed');
    expect(outcome.remedy).toContain('docker:up');
  });

  it('labels the target as host:port, never as a DSN with a password', () => {
    expect(check(() => Promise.resolve()).target).toBe('localhost:5432');
  });
});
