import { describe, expect, it } from 'vitest';

import {
  PinoLoggerAdapter,
  createRootLogger,
} from '../../../src/infrastructure/logging/pino-logger.adapter.js';

const capturing = (): { logger: PinoLoggerAdapter; entries: () => Record<string, unknown>[] } => {
  const written: string[] = [];
  const logger = new PinoLoggerAdapter(
    createRootLogger(
      { level: 'debug', version: '9.9.9' },
      { write: (line: string) => written.push(line) },
    ),
  );

  return {
    logger,
    entries: () => written.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
};

describe('LoggerPort over pino', () => {
  it.each([
    ['debug', 20],
    ['info', 30],
    ['warn', 40],
    ['error', 50],
  ] as const)('writes %s at the matching pino level', (level, numeric) => {
    const { logger, entries } = capturing();

    logger[level]({ taskId: '01J8' }, `${level} line`);

    expect(entries()[0]).toMatchObject({ level: numeric, taskId: '01J8', msg: `${level} line` });
  });

  it('stamps every line with the service, role and version of the build', () => {
    const { logger, entries } = capturing();

    logger.info({}, 'anything');

    expect(entries()[0]).toMatchObject({
      service: '@bad-crm/server',
      role: 'api',
      version: '9.9.9',
    });
  });

  /**
   * A child logger is how a subsystem (a queue worker, an integration) attaches permanent fields
   * without every call site repeating them — and it has to stay a `LoggerPort`, or the first
   * `logger.child(...)` inside a use-case would drag pino into `application`.
   */
  it('returns another LoggerPort from child(), with the bindings on every line', () => {
    const { logger, entries } = capturing();

    logger.child({ queue: 'outbox' }).warn({ jobId: '7' }, 'retrying');

    expect(entries()[0]).toMatchObject({ queue: 'outbox', jobId: '7', level: 40 });
  });
});
