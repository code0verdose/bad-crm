import { describe, expect, it } from 'vitest';

import { runCheckServices } from '../../scripts/lib/run-check-services.util.js';
import { runPreflight } from '../../scripts/lib/run-preflight.util.js';
import type { CheckResult, ServiceCheck } from '../../scripts/lib/service-check.types.js';
import type { EnvResolution } from '../../scripts/lib/check-env.util.js';

const okCheck = (
  service: string,
  requirement: 'required' | 'optional' = 'required',
): ServiceCheck => ({
  service,
  requirement,
  target: `${service}:1`,
  run: () => Promise.resolve({ status: 'ok', details: [`${service} answered`] }),
});

const failingCheck = (
  service: string,
  requirement: 'required' | 'optional' = 'required',
): ServiceCheck => ({
  service,
  requirement,
  target: `${service}:1`,
  run: () =>
    Promise.resolve({
      status: 'failed',
      details: ['connection refused'],
      remedy: 'start the stack with `pnpm docker:up`',
    }),
});

const VALID_ENV = {
  NODE_ENV: 'development',
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://app_user:pw@localhost:5432/bad_crm',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'bad-crm',
  S3_ACCESS_KEY: 'user',
  S3_SECRET_KEY: 'password',
} as unknown as EnvResolution['env'];

const resolution = (over: Partial<EnvResolution> = {}): EnvResolution => ({
  envFilePath: '/repo/.env',
  envFileExists: true,
  env: VALID_ENV,
  issues: [],
  profile: 'default',
  ...over,
});

const capture = () => {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
};

describe('runPreflight', () => {
  it('passes and stays quiet enough to precede pnpm dev', async () => {
    const output = capture();
    const code = await runPreflight({
      resolveEnv: () => resolution(),
      createChecks: () => [okCheck('postgres'), okCheck('redis'), okCheck('minio')],
      write: output.write,
      now: () => Date.now(),
    });

    expect(code).toBe(0);
    expect(output.lines.join('\n')).toContain('ready');
  });

  /**
   * The failure this whole script exists for: `pnpm dev` on a machine that never ran
   * `cp .env.example .env` used to die somewhere inside a driver with `ECONNREFUSED`.
   */
  it('stops with a copy-paste recipe when .env is missing', async () => {
    const output = capture();
    const code = await runPreflight({
      resolveEnv: () => resolution({ envFileExists: false, env: undefined }),
      createChecks: () => [],
      write: output.write,
      now: () => Date.now(),
    });
    const text = output.lines.join('\n');

    expect(code).toBe(1);
    expect(text).toContain('cp .env.example .env');
    expect(text).toContain('openssl rand -base64 32');
    expect(text).toContain('openssl rand -base64 48');
  });

  it('does not try to reach a service when the configuration itself is invalid', async () => {
    const output = capture();
    let created = false;
    const code = await runPreflight({
      resolveEnv: () =>
        resolution({
          env: undefined,
          issues: [{ variable: 'APP_ENCRYPTION_KEY', message: 'must be 32 bytes, base64-encoded' }],
        }),
      createChecks: () => {
        created = true;
        return [];
      },
      write: output.write,
      now: () => Date.now(),
    });

    expect(code).toBe(1);
    expect(created).toBe(false);
    expect(output.lines.join('\n')).toContain('APP_ENCRYPTION_KEY');
    expect(output.lines.join('\n')).toContain('must be 32 bytes, base64-encoded');
  });

  it('stops with the docker hint when a required service does not answer', async () => {
    const output = capture();
    const code = await runPreflight({
      resolveEnv: () => resolution(),
      createChecks: () => [okCheck('redis'), failingCheck('postgres')],
      write: output.write,
      now: () => Date.now(),
    });

    expect(code).toBe(1);
    expect(output.lines.join('\n')).toContain('pnpm docker:up');
  });

  /**
   * Optional services degrade by design (stack.md). Blocking `pnpm dev` because the mail catcher is
   * down would make the `minimal` profile unusable.
   */
  it('warns but does not block when an optional service is down', async () => {
    const output = capture();
    const code = await runPreflight({
      resolveEnv: () => resolution(),
      createChecks: () => [okCheck('postgres'), failingCheck('meilisearch', 'optional')],
      write: output.write,
      now: () => Date.now(),
    });

    expect(code).toBe(0);
    expect(output.lines.join('\n').toLowerCase()).toContain('warning');
  });

  it('never prints a password that reached it through the environment', async () => {
    const output = capture();
    await runPreflight({
      resolveEnv: () => resolution(),
      createChecks: () => [okCheck('postgres')],
      write: output.write,
      now: () => Date.now(),
    });

    expect(output.lines.join('\n')).not.toContain('pw@');
  });
});

describe('runCheckServices', () => {
  it('reports every service and exits 0 when the required ones are healthy', async () => {
    const output = capture();
    const code = await runCheckServices({
      resolveEnv: () => resolution(),
      createChecks: () => [
        okCheck('postgres'),
        okCheck('redis'),
        okCheck('minio'),
        okCheck('meilisearch', 'optional'),
      ],
      write: output.write,
      now: () => Date.now(),
    });

    expect(code).toBe(0);
    for (const service of ['postgres', 'redis', 'minio', 'meilisearch']) {
      expect(output.lines.join('\n')).toContain(service);
    }
  });

  it('exits 1 when a required service failed', async () => {
    const output = capture();
    const code = await runCheckServices({
      resolveEnv: () => resolution(),
      createChecks: () => [okCheck('redis'), failingCheck('minio')],
      write: output.write,
      now: () => Date.now(),
    });

    expect(code).toBe(1);
    expect(output.lines.join('\n')).toContain('pnpm docker:up');
  });

  it('exits 1 with the list of invalid variables instead of connecting anywhere', async () => {
    const output = capture();
    const code = await runCheckServices({
      resolveEnv: () =>
        resolution({
          env: undefined,
          issues: [{ variable: 'REDIS_URL', message: 'must be a URL' }],
        }),
      createChecks: () => [okCheck('redis')],
      write: output.write,
      now: () => Date.now(),
    });

    expect(code).toBe(1);
    expect(output.lines.join('\n')).toContain('REDIS_URL');
  });

  it('tells the operator to create .env when there is none', async () => {
    const output = capture();
    const code = await runCheckServices({
      resolveEnv: () => resolution({ envFileExists: false, env: undefined }),
      createChecks: () => [],
      write: output.write,
      now: () => Date.now(),
    });

    expect(code).toBe(1);
    expect(output.lines.join('\n')).toContain('cp .env.example .env');
  });
});

describe('the report never leaks a secret', () => {
  it('keeps the secret out of the output even when a check puts it in its details', async () => {
    const output = capture();
    const leaking: ServiceCheck = {
      service: 'postgres',
      requirement: 'required',
      target: 'localhost:5432',
      run: () =>
        Promise.resolve({
          status: 'failed',
          details: ['dsn postgres://app_user:hunter2@localhost:5432/bad_crm rejected'],
        } as CheckResult),
    };

    await runCheckServices({
      resolveEnv: () => resolution(),
      createChecks: () => [leaking],
      write: output.write,
      now: () => Date.now(),
    });

    expect(output.lines.join('\n')).not.toContain('hunter2');
  });
});
