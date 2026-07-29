import type { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';

import { EnvValidationError, toEnvIssues } from '../../src/infrastructure/bootstrap/env.errors.js';
import {
  describeDegradations,
  insecureDefaultWarnings,
} from '../../src/infrastructure/bootstrap/env-features.util.js';
import { loadEnv } from '../../src/infrastructure/bootstrap/load-env.util.js';
import {
  REQUIRED_ENV_KEYS,
  serverEnvSchema,
} from '../../src/infrastructure/bootstrap/env.schema.js';

/** 32 bytes, base64 — the only shape `APP_ENCRYPTION_KEY` accepts. */
const VALID_ENCRYPTION_KEY = `${'A'.repeat(43)}=`;

/** A configuration where nothing optional is set: the `minimal` profile of a real installation. */
const VALID_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  APP_URL: 'https://crm.example.com',
  DATABASE_URL: 'postgres://app_user:secret@localhost:5432/bad_crm',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'j'.repeat(32),
  APP_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'bad-crm',
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
};

const withEnv = (overrides: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(
    Object.entries({ ...VALID_ENV, ...overrides }).filter(([, value]) => value !== undefined),
  ) as Record<string, string>;

const without = (key: string): Record<string, string> => withEnv({ [key]: undefined });

const issuePathsOf = (source: Record<string, string>): string[] => {
  const result = serverEnvSchema.safeParse(source);

  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
};

describe('a valid configuration', () => {
  it('parses and applies the documented defaults', () => {
    const env = loadEnv(VALID_ENV);

    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.S3_REGION).toBe('us-east-1');
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
    expect(env.AI_ENABLED).toBe(false);
    expect(env.RUN_WORKERS_IN_PROCESS).toBe(false);
  });

  it('ignores variables it does not declare, so a shell full of exports still starts', () => {
    const env = loadEnv({
      ...VALID_ENV,
      HOME: '/root',
      // A compose development default, not a real secret. Both markers, because the perl matcher
      // of scan-secrets.sh reads one spelling and gitleaks the other (rules/security.mdc).
      POSTGRES_PASSWORD: 'dev_postgres_password', // scan-secrets:allow gitleaks:allow
    });

    expect(env.APP_URL).toBe('https://crm.example.com');
  });
});

describe('missing required variables', () => {
  it.each([...REQUIRED_ENV_KEYS])('fails with %s in the error path', (key) => {
    expect(issuePathsOf(without(key))).toContain(key);
  });

  it('reports every invalid variable at once, not just the first', () => {
    const paths = issuePathsOf(withEnv({ JWT_SECRET: undefined, APP_ENCRYPTION_KEY: undefined }));

    expect(paths).toEqual(expect.arrayContaining(['JWT_SECRET', 'APP_ENCRYPTION_KEY']));
  });

  it('throws EnvValidationError naming the variable and the requirement', () => {
    expect(() => loadEnv(without('JWT_SECRET'))).toThrow(EnvValidationError);
    expect(() => loadEnv(without('JWT_SECRET'))).toThrow(/JWT_SECRET/);
  });
});

describe('secret shape', () => {
  it('rejects an APP_ENCRYPTION_KEY that is not 32 bytes of base64', () => {
    for (const key of ['too-short', 'AAAA', `${'A'.repeat(23)}=`, `${'A'.repeat(87)}=`]) {
      expect(issuePathsOf(withEnv({ APP_ENCRYPTION_KEY: key }))).toContain('APP_ENCRYPTION_KEY');
    }
  });

  /**
   * `'AAAAA'` passes the base64 character check and still cannot be decoded: five characters is
   * not a whole number of base64 quanta, so `atob` throws `InvalidCharacterError`. That is the
   * only input that reaches the `catch` in `isBase64Bytes`; without it the guard is untested and
   * a future refactor could let the exception escape as a stack trace instead of the sentence the
   * operator needs.
   */
  it('rejects a base64-looking key whose length makes it undecodable, without throwing', () => {
    const result = serverEnvSchema.safeParse(withEnv({ APP_ENCRYPTION_KEY: 'AAAAA' }));

    expect(result.success).toBe(false);
    expect(issuePathsOf(withEnv({ APP_ENCRYPTION_KEY: 'AAAAA' }))).toContain('APP_ENCRYPTION_KEY');
  });

  it('explains the APP_ENCRYPTION_KEY requirement in plain words for the operator', () => {
    expect(() => loadEnv(withEnv({ APP_ENCRYPTION_KEY: 'nope' }))).toThrow(
      /APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded/,
    );
  });

  it('rejects a JWT_SECRET below the minimum length', () => {
    expect(issuePathsOf(withEnv({ JWT_SECRET: 'short' }))).toContain('JWT_SECRET');
  });
});

describe('typed scalars', () => {
  it.each(['not-a-number', '0', '-1', '70000', '3000.5'])('rejects PORT=%o', (port) => {
    expect(issuePathsOf(withEnv({ PORT: port }))).toContain('PORT');
  });

  it('coerces a numeric PORT, because a shell only has strings', () => {
    expect(loadEnv(withEnv({ PORT: '8080' })).PORT).toBe(8080);
  });

  it('rejects an unknown LOG_LEVEL instead of silently falling back to info', () => {
    expect(issuePathsOf(withEnv({ LOG_LEVEL: 'verbose' }))).toContain('LOG_LEVEL');
  });

  it.each(['NODE_ENV', 'MEILI_ENV'])('rejects an unknown %s', (key) => {
    expect(issuePathsOf(withEnv({ [key]: 'staging' }))).toContain(key);
  });

  it.each(['not-a-url', 'mysql://localhost/db'])('rejects DATABASE_URL=%o', (url) => {
    expect(issuePathsOf(withEnv({ DATABASE_URL: url }))).toContain('DATABASE_URL');
  });

  it('rejects a REDIS_URL with the wrong scheme', () => {
    expect(issuePathsOf(withEnv({ REDIS_URL: 'http://localhost:6379' }))).toContain('REDIS_URL');
  });

  it.each([
    ['true', true],
    ['false', false],
    ['1', true],
    ['0', false],
  ] as const)('coerces AI_ENABLED=%o to %s', (raw, expected) => {
    expect(loadEnv(withEnv({ AI_ENABLED: raw })).AI_ENABLED).toBe(expected);
  });

  it('rejects a boolean it cannot interpret rather than guessing', () => {
    expect(issuePathsOf(withEnv({ AI_ENABLED: 'maybe' }))).toContain('AI_ENABLED');
  });
});

/**
 * `docs/security/threat-model.md` (T-SH-01, T-SH-03) scopes the hardening preflight to everything
 * that is *not* `development` — not to `production` alone. The difference is not academic: a
 * deployment left on `NODE_ENV=test` is still reachable from the internet, and scoping the checks
 * to `production` lets it boot on a placeholder `JWT_SECRET` published in a public AGPL repository.
 */
describe('hardening preflight is scoped by NODE_ENV', () => {
  // The .env.example placeholder this test asserts is rejected; marked in both syntaxes so the
  // verdict of scan-secrets.sh does not depend on whether gitleaks happens to be installed.
  const PLACEHOLDER_SECRET = 'CHANGE_ME_generate_with_openssl_rand_base64_48'; // scan-secrets:allow gitleaks:allow

  it.each(['production', 'test'] as const)('refuses a placeholder secret under %s', (nodeEnv) => {
    expect(issuePathsOf(withEnv({ NODE_ENV: nodeEnv, JWT_SECRET: PLACEHOLDER_SECRET }))).toContain(
      'JWT_SECRET',
    );
  });

  it.each(['production', 'test'] as const)('refuses a plaintext APP_URL under %s', (nodeEnv) => {
    expect(
      issuePathsOf(withEnv({ NODE_ENV: nodeEnv, APP_URL: 'http://crm.example.com' })),
    ).toContain('APP_URL');
  });

  it('still allows both under development, where http and placeholders are the point', () => {
    const env = loadEnv(
      withEnv({
        NODE_ENV: 'development',
        APP_URL: 'http://localhost:3000',
        JWT_SECRET: PLACEHOLDER_SECRET,
      }),
    );

    expect(env.NODE_ENV).toBe('development');
  });
});

/**
 * The Argon2id parameters and the CORS allow-list extension were declared with no test at all.
 * Both are load-bearing: `ARGON2_MEMORY_COST=0` would silently reduce password hashing to
 * something a laptop brute-forces, and a fractional or negative cost is a `@node-rs/argon2` panic
 * at the first login rather than a refusal to start.
 */
describe('password hashing parameters', () => {
  const ARGON2_KEYS = ['ARGON2_MEMORY_COST', 'ARGON2_TIME_COST', 'ARGON2_PARALLELISM'] as const;

  it('applies the OWASP-derived defaults when the operator sets nothing', () => {
    const env = loadEnv(VALID_ENV);

    expect(env.ARGON2_MEMORY_COST).toBe(19_456);
    expect(env.ARGON2_TIME_COST).toBe(2);
    expect(env.ARGON2_PARALLELISM).toBe(1);
  });

  it.each(ARGON2_KEYS)('coerces a numeric %s, because a shell only has strings', (key) => {
    expect(loadEnv(withEnv({ [key]: '4' }))[key]).toBe(4);
  });

  it.each(
    ARGON2_KEYS.flatMap((key) => ['0', '-1', '3.5', 'abc'].map((value) => [key, value] as const)),
  )('rejects %s=%o instead of weakening the hash', (key, value) => {
    expect(issuePathsOf(withEnv({ [key]: value }))).toContain(key);
  });

  it.each(ARGON2_KEYS)('names %s in the operator-facing message', (key) => {
    expect(() => loadEnv(withEnv({ [key]: '0' }))).toThrow(new RegExp(key));
  });
});

/**
 * How many `X-Forwarded-For` hops the process believes.
 *
 * A default of `0` and not `1`: the shipped `docker-compose.yml` has no reverse proxy in it, so on
 * the deployment this product actually describes there is no hop between the client and Node — and
 * a process that trusts one takes the client's own header as its address. That address is written
 * into `sessions.ip_hash` / `sessions.ip_masked` and is the rate limiter's key.
 */
describe('TRUSTED_PROXY_HOPS', () => {
  it('trusts nothing by default, because the shipped compose file ships no proxy', () => {
    expect(loadEnv(VALID_ENV).TRUSTED_PROXY_HOPS).toBe(0);
  });

  it('coerces the number an operator with a proxy sets', () => {
    expect(loadEnv(withEnv({ TRUSTED_PROXY_HOPS: '1' })).TRUSTED_PROXY_HOPS).toBe(1);
  });

  it.each(['-1', '1.5', 'true', ''])('refuses %o rather than guessing a hop count', (value) => {
    expect(issuePathsOf(withEnv({ TRUSTED_PROXY_HOPS: value }))).toContain('TRUSTED_PROXY_HOPS');
  });

  it('names the variable in the operator-facing message', () => {
    expect(() => loadEnv(withEnv({ TRUSTED_PROXY_HOPS: '-1' }))).toThrow(/TRUSTED_PROXY_HOPS/);
  });
});

describe('CORS_EXTRA_ORIGINS', () => {
  it('is absent by default: only APP_URL is allowed until an operator widens it', () => {
    expect(loadEnv(VALID_ENV).CORS_EXTRA_ORIGINS).toBeUndefined();
  });

  it('is carried through verbatim, so the parsing stays in one place downstream', () => {
    const raw = 'https://a.example.com,https://b.example.com';

    expect(loadEnv(withEnv({ CORS_EXTRA_ORIGINS: raw })).CORS_EXTRA_ORIGINS).toBe(raw);
  });

  it('accepts an empty value as "nothing extra", not as an error', () => {
    expect(serverEnvSchema.safeParse(withEnv({ CORS_EXTRA_ORIGINS: '' })).success).toBe(true);
  });
});

/**
 * A misconfigured installation must learn about **all** of its problems from one start attempt.
 *
 * In Zod 4 a `superRefine` does not run when the object parse already failed, so the cross-field
 * rules were invisible whenever any single field was invalid: the operator fixed
 * `APP_ENCRYPTION_KEY`, restarted, and only then heard that `MEILI_HOST` needs a master key. For an
 * installation that is brought up once, that turns a five-minute setup into an afternoon of
 * restarts — and the comment above `serverEnvSchema` promised exactly the opposite behaviour.
 */
describe('every configuration problem arrives in one list', () => {
  const issuesOf = (source: Record<string, string>): { variable: string; message: string }[] => {
    try {
      loadEnv(source);
    } catch (error) {
      return [...(error as EnvValidationError).issues];
    }

    throw new Error('expected loadEnv to reject this configuration');
  };

  it('reports a broken field and a violated cross-field rule together', () => {
    const variables = issuesOf(
      withEnv({
        APP_ENCRYPTION_KEY: 'nope',
        MEILI_HOST: 'http://localhost:7700',
        MEILI_MASTER_KEY: undefined,
      }),
    ).map((issue) => issue.variable);

    expect(variables).toContain('APP_ENCRYPTION_KEY');
    expect(variables).toContain('MEILI_MASTER_KEY');
  });

  it('reports a broken field together with the production hardening preflight', () => {
    const variables = issuesOf(
      withEnv({
        NODE_ENV: 'production',
        JWT_SECRET: 'too-short',
        APP_URL: 'http://crm.example.com',
      }),
    ).map((issue) => issue.variable);

    expect(variables).toContain('JWT_SECRET');
    expect(variables).toContain('APP_URL');
  });

  /**
   * The case that actually regressed. Zod treats a failed coercion as fatal and abandons the
   * object, so the `superRefine` never ran: `PORT=abc` in a production `.env` with a plaintext
   * `APP_URL` reported the port alone. A `min()` or `refine()` failure does not abort, which is why
   * the defect looked absent whenever it was reproduced with a short secret.
   */
  it.each([
    ['PORT', 'abc'],
    ['NODE_ENV', 'production'],
    ['LOG_LEVEL', 'verbose'],
  ])('reports the preflight even when %s fails fatally', (key, value) => {
    const variables = issuesOf(
      withEnv({ NODE_ENV: 'production', APP_URL: 'http://crm.example.com', [key]: value }),
    ).map((issue) => issue.variable);

    expect(variables).toContain('APP_URL');
  });

  it('does not repeat an issue that both passes found', () => {
    const issues = issuesOf(
      withEnv({ MEILI_HOST: 'http://localhost:7700', MEILI_MASTER_KEY: undefined }),
    );
    const keys = issues.map((issue) => `${issue.variable}: ${issue.message}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('skips the preflight when NODE_ENV itself is unreadable, instead of guessing', () => {
    // Which rules apply depends on the value that failed to parse. Telling an operator who meant
    // `development` that their placeholder secret is unacceptable would be wrong advice, and the
    // issue naming NODE_ENV is already in the list.
    const variables = issuesOf(
      withEnv({ NODE_ENV: 'staging', JWT_SECRET: 'CHANGE_ME_placeholder_secret_value_long' }), // scan-secrets:allow gitleaks:allow
    ).map((issue) => issue.variable);

    expect(variables).toEqual(['NODE_ENV']);
  });
});

/**
 * Not every failure has a variable to blame: a `.env` that parses to something other than an
 * object produces an issue with an empty path. `toEnvIssues` labels it `<root>` so the message
 * stays a complete sentence instead of `: Invalid input`.
 */
describe('issues that belong to no single variable', () => {
  it('labels a path-less issue <root>', () => {
    const result = serverEnvSchema.safeParse('DATABASE_URL=postgres://localhost/db');

    expect(result.success).toBe(false);
    expect(toEnvIssues(result.error as ZodError).map((issue) => issue.variable)).toEqual([
      '<root>',
    ]);
  });

  it('still produces a readable EnvValidationError message', () => {
    const issues = toEnvIssues(serverEnvSchema.safeParse('not an env object').error as ZodError);

    expect(new EnvValidationError(issues).message).toContain('<root>');
  });
});

describe('optional services degrade instead of blocking the start', () => {
  it('starts with no Meilisearch, no SMTP, no OTel and no AI', () => {
    const env = loadEnv(VALID_ENV);

    expect(env.MEILI_HOST).toBeUndefined();
    expect(env.SMTP_URL).toBeUndefined();
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(env.AI_ENABLED).toBe(false);
  });

  /**
   * `authentication` leads the list because it is the one entry that is not an optional service:
   * `DATABASE_AUTH_URL` is `.optional()` in the schema and required in meaning, so its absence is a
   * `blocking` degradation carrying the sentence that says what to do — see
   * `test/unit/bootstrap/auth-availability.test.ts` for the rest of that behaviour.
   */
  it('reports what is degraded, so the operator sees it in the startup log', () => {
    const degradations = describeDegradations(loadEnv(VALID_ENV));

    expect(degradations).toEqual([
      {
        feature: 'authentication',
        fallback: 'unavailable',
        blocking: true,
        remedy: expect.stringContaining('DATABASE_AUTH_URL') as string,
      },
      { feature: 'search', fallback: 'postgres-fts', blocking: false },
      { feature: 'mail', fallback: 'unavailable', blocking: false },
      { feature: 'ai', fallback: 'disabled', blocking: false },
      { feature: 'tracing', fallback: 'disabled', blocking: false },
    ]);
  });

  it('reports nothing degraded once every optional service is configured', () => {
    const env = loadEnv(
      withEnv({
        DATABASE_AUTH_URL: 'postgres://app_auth:secret@localhost:5432/bad_crm',
        MEILI_HOST: 'http://localhost:7700',
        MEILI_MASTER_KEY: 'm'.repeat(16),
        SMTP_URL: 'smtp://localhost:1025',
        MAIL_FROM: 'Bad CRM <crm@example.com>',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        AI_ENABLED: 'true',
      }),
    );

    expect(describeDegradations(env)).toEqual([]);
  });

  it('demands the master key once MEILI_HOST is set (cross-field refine)', () => {
    expect(issuePathsOf(withEnv({ MEILI_HOST: 'http://localhost:7700' }))).toContain(
      'MEILI_MASTER_KEY',
    );
  });
});

describe('production hardening (rules/security.mdc, T-SH-01)', () => {
  const production = (overrides: Record<string, string | undefined> = {}): Record<string, string> =>
    withEnv({ NODE_ENV: 'production', ...overrides });

  it.each(['JWT_SECRET', 'APP_ENCRYPTION_KEY', 'S3_SECRET_KEY'])(
    'refuses to start with a CHANGE_ME placeholder in %s',
    (key) => {
      expect(issuePathsOf(production({ [key]: `CHANGE_ME_${'x'.repeat(40)}` }))).toContain(key);
    },
  );

  it('refuses to start with a compose dev default in a connection string', () => {
    expect(
      issuePathsOf(
        production({ DATABASE_URL: 'postgres://app_user:dev_app_user_password@db:5432/bad_crm' }),
      ),
    ).toContain('DATABASE_URL');
  });

  it('refuses a plaintext APP_URL, which would send session cookies in the clear', () => {
    expect(issuePathsOf(production({ APP_URL: 'http://crm.example.com' }))).toContain('APP_URL');
  });

  it('still allows an http APP_URL on localhost, where there is no network to sniff', () => {
    expect(
      serverEnvSchema.safeParse(production({ APP_URL: 'http://localhost:3000' })).success,
    ).toBe(true);
  });

  it('accepts a production configuration with real secrets', () => {
    expect(serverEnvSchema.safeParse(production()).success).toBe(true);
  });

  it('only warns about the same placeholders in development', () => {
    const source = withEnv({ NODE_ENV: 'development', JWT_SECRET: `CHANGE_ME_${'x'.repeat(40)}` });

    expect(serverEnvSchema.safeParse(source).success).toBe(true);
    expect(insecureDefaultWarnings(loadEnv(source))).toEqual([
      expect.stringContaining('JWT_SECRET'),
    ]);
  });

  it('warns about nothing when development secrets are real', () => {
    expect(insecureDefaultWarnings(loadEnv(VALID_ENV))).toEqual([]);
  });
});

/**
 * The envelope sender, which an installation with a relay cannot do without.
 *
 * **Warned about, not demanded** — and the first version of this delta demanded it. Tying a hard
 * requirement to `SMTP_URL` refuses to start every installation built from `.env.example`, which has
 * carried `SMTP_URL` since EPIC-001, for a subsystem no route uses yet. `rules/self-host-packaging`
 * rule 2 is explicit about the shape: release N warns, release N+1 refuses. The warning lives in
 * `describeDegradations` as a blocking degradation, the same mechanism `DATABASE_AUTH_URL` uses.
 */
describe('MAIL_FROM', () => {
  it('does not stop an existing installation from starting', () => {
    // Not `issuePathsOf`: that helper asserts the parse fails, and the point here is that it no
    // longer does. Every environment built from `.env.example` carries `SMTP_URL`.
    expect(() => loadEnv(withEnv({ SMTP_URL: 'smtp://localhost:1025' }))).not.toThrow();
  });

  it('is named as a blocking degradation instead, with a remedy', () => {
    const degraded = describeDegradations(loadEnv(withEnv({ SMTP_URL: 'smtp://localhost:1025' })));

    expect(degraded).toContainEqual({
      feature: 'mail',
      fallback: 'unavailable',
      blocking: true,
      remedy: expect.stringContaining('MAIL_FROM') as string,
    });
  });

  it('stops being named once the sender is configured', () => {
    const degraded = describeDegradations(
      loadEnv(withEnv({ SMTP_URL: 'smtp://localhost:1025', MAIL_FROM: 'crm@example.com' })),
    );

    expect(degraded.filter((entry) => entry.feature === 'mail')).toEqual([]);
  });

  it('is not demanded of an installation that sends no mail', () => {
    expect(loadEnv(VALID_ENV).MAIL_FROM).toBeUndefined();
  });

  it('accepts a display name beside the address', () => {
    const env = loadEnv(
      withEnv({ SMTP_URL: 'smtp://localhost:1025', MAIL_FROM: 'Bad CRM <crm@example.com>' }),
    );

    expect(env.MAIL_FROM).toBe('Bad CRM <crm@example.com>');
  });

  /** The value ends up in a message header, and CR or LF in a header value is header injection. */
  it('refuses a line break', () => {
    expect(
      issuePathsOf(
        withEnv({
          SMTP_URL: 'smtp://localhost:1025',
          MAIL_FROM: 'crm@example.com\r\nBcc: everyone@example.com',
        }),
      ),
    ).toContain('MAIL_FROM');
  });

  it('refuses a value that is not an address at all', () => {
    expect(
      issuePathsOf(withEnv({ SMTP_URL: 'smtp://localhost:1025', MAIL_FROM: 'Bad CRM' })),
    ).toContain('MAIL_FROM');
  });
});
