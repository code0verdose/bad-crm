import { describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { Logger } from 'pino';

import { startApiProcess } from '../../../src/infrastructure/bootstrap/api-process.factory.js';
import { createRootLogger } from '../../../src/infrastructure/logging/pino-logger.adapter.js';
import { EnvValidationError } from '../../../src/infrastructure/bootstrap/env.errors.js';
import { UnsafeDatabaseRoleError } from '../../../src/infrastructure/persistence/prisma/assert-db-role.util.js';
import type { DatabaseConnection } from '../../../src/infrastructure/persistence/prisma/database.factory.js';
import type { ServerEnv } from '../../../src/infrastructure/bootstrap/env.schema.js';

const VALID_ENCRYPTION_KEY = `${'A'.repeat(43)}=`;

const testEnv = (overrides: Partial<ServerEnv> = {}): ServerEnv =>
  ({
    NODE_ENV: 'test',
    PORT: 4321,
    APP_URL: 'https://crm.example.com',
    CORS_EXTRA_ORIGINS: undefined,
    DATABASE_URL: 'postgres://app_user:secret@localhost:5432/bad_crm',
    DATABASE_MIGRATION_URL: undefined,
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'j'.repeat(32),
    APP_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'bad-crm',
    S3_ACCESS_KEY: 'access-key',
    S3_SECRET_KEY: 'secret-key',
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: true,
    SMTP_URL: undefined,
    MEILI_HOST: undefined,
    MEILI_MASTER_KEY: undefined,
    MEILI_ENV: undefined,
    AI_ENABLED: false,
    LOG_LEVEL: 'info',
    OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
    RUN_WORKERS_IN_PROCESS: false,
    ARGON2_MEMORY_COST: 19_456,
    ARGON2_TIME_COST: 2,
    ARGON2_PARALLELISM: 1,
    ...overrides,
  }) as ServerEnv;

interface Harness {
  readonly order: string[];
  readonly lines: string[];
  readonly listened: number[];
  readonly signals: Map<string, () => void>;
  readonly exitCodes: number[];
  readonly fatals: string[];
  readonly closed: string[];
  readonly closeListener: () => void;
}

/**
 * A stand-in for the database connection, shaped only where the startup sequence touches it.
 *
 * The real one opens a pool; here what matters is that it is created before the role is verified,
 * that the port is opened after both, and that it is closed on shutdown.
 */
const fakeDatabase = (closed: string[]): DatabaseConnection =>
  ({
    base: {},
    guarded: {},
    close: () => {
      closed.push('database');

      return Promise.resolve();
    },
  }) as unknown as DatabaseConnection;

const harness = (
  overrides: {
    loadEnvironment?: () => ServerEnv;
    verifyDatabaseRole?: () => Promise<void>;
  } = {},
) => {
  const order: string[] = [];
  const lines: string[] = [];
  const listened: number[] = [];
  const signals = new Map<string, () => void>();
  const exitCodes: number[] = [];
  const fatals: string[] = [];
  const closed: string[] = [];
  let listenerCallback: (() => void) | undefined;

  const start = startApiProcess({
    loadEnvironment: () => {
      order.push('env');

      return (overrides.loadEnvironment ?? (() => testEnv()))();
    },
    createLogger: (): Logger => {
      order.push('logger');

      return createRootLogger(
        { level: 'debug', version: '0.0.0' },
        { write: (line: string) => lines.push(line) },
      );
    },
    connectDatabase: () => {
      order.push('database');

      return fakeDatabase(closed);
    },
    verifyDatabaseRole: () => {
      order.push('db-role');

      return overrides.verifyDatabaseRole?.() ?? Promise.resolve();
    },
    listen: (_app: Express, port: number) => {
      order.push('listen');
      listened.push(port);

      return Promise.resolve({
        close: (callback: () => void) => {
          listenerCallback = callback;
        },
      });
    },
    onSignal: (signal, handler) => signals.set(signal, handler),
    exit: (code) => exitCodes.push(code),
    reportFatal: (message) => fatals.push(message),
  });

  const state: Harness = {
    order,
    lines,
    listened,
    signals,
    exitCodes,
    fatals,
    closed,
    closeListener: () => listenerCallback?.(),
  };

  return { start, state };
};

describe('startApiProcess', () => {
  /**
   * The order is the contract of STORY-003-01: configuration is validated **before** the port is
   * open. A process that starts listening and only then discovers a missing `APP_ENCRYPTION_KEY`
   * has already accepted requests it cannot serve, and a rolling deploy treats it as healthy.
   */
  it('validates the environment, builds the logger and only then listens', async () => {
    const { start, state } = harness();

    await start;

    expect(state.order).toEqual(['env', 'logger', 'database', 'db-role', 'listen']);
    expect(state.listened).toEqual([4321]);
    expect(state.exitCodes).toEqual([]);
  });

  /**
   * Invariant 1 of CLAUDE.md, at the one moment it can still be checked cheaply.
   *
   * A connection made as the schema owner, as a superuser or as any `BYPASSRLS` role serves every
   * request correctly and filters nothing — the failure has no symptom until a tenant reads another
   * tenant's data. The process therefore refuses to open the port, which is the only signal that
   * reaches an operator before the leak does.
   */
  it('refuses to open the port when the database role can escape row level security', async () => {
    const { start, state } = harness({
      verifyDatabaseRole: () =>
        Promise.reject(
          new UnsafeDatabaseRoleError([
            'the role has BYPASSRLS — the tenant policies are not applied',
          ]),
        ),
    });

    await start;

    expect(state.order).toEqual(['env', 'logger', 'database', 'db-role']);
    expect(state.listened).toEqual([]);
    expect(state.exitCodes).toEqual([1]);
    expect(state.fatals.join('\n')).toContain('BYPASSRLS');
  });

  it('closes the database pool it opened when the process shuts down', async () => {
    const { start, state } = harness();

    await start;
    state.signals.get('SIGTERM')?.();
    state.closeListener();
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.closed).toEqual(['database']);
  });

  it('announces the port and the degraded optional services, so the log says what is off', async () => {
    const { start, state } = harness();

    await start;

    const startup = state.lines.join('\n');

    expect(startup).toContain('"port":4321');
    // Nothing optional is configured in this environment: search falls back, mail goes to the log,
    // AI and tracing are off. Silence here is indistinguishable from a fully configured install.
    expect(startup).toContain('postgres-fts');
  });

  /**
   * A laptop legitimately runs on the compose defaults; a server must not. The warning exists so
   * that the day a development `.env` is copied onto a host, the log already said so — in
   * production the same value is a refusal to start (`env.schema.ts`).
   */
  it('warns about a development placeholder that is still in use', async () => {
    const { start, state } = harness({
      loadEnvironment: () =>
        testEnv({
          NODE_ENV: 'development',
          DATABASE_URL: 'postgres://app_user:dev_postgres_password@localhost:5432/bad_crm', // scan-secrets:allow gitleaks:allow
        }),
    });

    await start;

    expect(state.lines.join('\n')).toContain('insecure development default in use');
  });

  it('registers a handler for both signals a container manager sends', async () => {
    const { start, state } = harness();

    await start;

    expect([...state.signals.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('shuts down and exits 0 when the signal arrives', async () => {
    const { start, state } = harness();

    await start;
    state.signals.get('SIGTERM')?.();
    state.closeListener();
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.exitCodes).toEqual([0]);
  });

  /**
   * An invalid configuration must produce one readable sentence and a non-zero exit — not a stack
   * trace, and not a listening process. The message goes through `reportFatal` because at this
   * point there is no logger yet: the logger needs `LOG_LEVEL`, which is part of what failed.
   */
  it('refuses to start on an invalid environment, before any port is opened', async () => {
    const { start, state } = harness({
      loadEnvironment: () => {
        throw new EnvValidationError([
          { variable: 'APP_ENCRYPTION_KEY', message: 'must be 32 bytes, base64-encoded' },
        ]);
      },
    });

    await start;

    expect(state.order).toEqual(['env']);
    expect(state.listened).toEqual([]);
    expect(state.exitCodes).toEqual([1]);
    expect(state.fatals.join('\n')).toContain('APP_ENCRYPTION_KEY');
  });

  it('never prints the value of a variable it rejects', async () => {
    const { start, state } = harness({
      loadEnvironment: () => {
        throw new EnvValidationError([
          { variable: 'JWT_SECRET', message: 'must contain at least 32 character(s)' },
        ]);
      },
    });

    await start;

    expect(state.fatals.join('\n')).toContain('JWT_SECRET');
    expect(state.fatals.join('\n')).not.toContain('j'.repeat(32));
  });

  it('exits 1 when a later startup step fails, such as the port already being in use', async () => {
    const exitCodes: number[] = [];
    const fatals: string[] = [];

    await startApiProcess({
      loadEnvironment: () => testEnv(),
      createLogger: () =>
        createRootLogger({ level: 'silent', version: '0.0.0' }, { write: () => undefined }),
      connectDatabase: () => fakeDatabase([]),
      verifyDatabaseRole: () => Promise.resolve(),
      listen: () => Promise.reject(new Error('listen EADDRINUSE: address already in use :::4321')),
      onSignal: () => undefined,
      exit: (code) => exitCodes.push(code),
      reportFatal: (message) => fatals.push(message),
    });

    expect(exitCodes).toEqual([1]);
    expect(fatals.join('\n')).toContain('EADDRINUSE');
  });
});
