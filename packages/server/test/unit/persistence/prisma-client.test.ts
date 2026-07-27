import { describe, expect, it } from 'vitest';

import {
  SLOW_QUERY_THRESHOLD_MS,
  createPrismaClient,
  createSlowQueryLogger,
} from '@/infrastructure/persistence/prisma/prisma.client.js';
import { type LogFields, type LoggerPort } from '@/application/platform/ports/logger.port.js';

interface Line {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly fields: LogFields;
  readonly message: string;
}

const recordingLogger = (): { lines: Line[]; logger: LoggerPort } => {
  const lines: Line[] = [];
  const at =
    (level: Line['level']) =>
    (fields: LogFields, message: string): void => {
      lines.push({ level, fields, message });
    };
  const logger: LoggerPort = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (): LoggerPort => logger,
  };

  return { lines, logger };
};

const queryEvent = (durationMs: number) => ({
  timestamp: new Date('2026-07-27T10:00:00.000Z'),
  query: 'SELECT id FROM teams WHERE organization_id = $1',
  params: '["018f4a3b-0000-7000-8000-000000000001"]',
  duration: durationMs,
  target: 'quaint::connector::metrics',
});

/** A URL that parses but is never dialled: the client only connects on the first query. */
const UNUSED_URL = 'postgresql://app_user:unused@127.0.0.1:1/bad_crm';

describe('slow query logging', () => {
  it('reports a query at or over the threshold', () => {
    const { lines, logger } = recordingLogger();

    createSlowQueryLogger(logger, 100)(queryEvent(100));

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('warn');
    expect(lines[0]?.fields).toMatchObject({ durationMs: 100, event: 'db.query.slow' });
  });

  it('stays quiet below the threshold, so the log keeps a signal', () => {
    const { lines, logger } = recordingLogger();

    createSlowQueryLogger(logger, 100)(queryEvent(99));

    expect(lines).toEqual([]);
  });

  /**
   * The statement text is diagnosable and safe — its values are `$1` placeholders. `event.params`
   * is the opposite: it carries the bound values, which include password hashes, token hashes and
   * encrypted blobs. It must never reach a log line (CLAUDE.md, «Что нельзя логировать никогда»).
   */
  it('logs the statement but never its bound parameters', () => {
    const { lines, logger } = recordingLogger();
    const event = queryEvent(500);

    createSlowQueryLogger(logger, 100)(event);

    const serialised = JSON.stringify(lines[0]);

    expect(serialised).toContain('organization_id = $1');
    expect(serialised).not.toContain('018f4a3b-0000-7000-8000-000000000001');
    expect(Object.keys(lines[0]?.fields ?? {})).not.toContain('params');
  });

  it('defaults the threshold instead of leaving it to each call site', () => {
    expect(SLOW_QUERY_THRESHOLD_MS).toBeGreaterThan(0);
  });
});

describe('createPrismaClient', () => {
  it('builds a client that can be shut down through a single $disconnect', async () => {
    const { logger } = recordingLogger();
    const client = createPrismaClient({ url: UNUSED_URL, logger });

    expect(typeof client.$disconnect).toBe('function');
    await expect(client.$disconnect()).resolves.toBeUndefined();
  });

  it('accepts an installation-specific slow query threshold', async () => {
    const { logger } = recordingLogger();
    const client = createPrismaClient({ url: UNUSED_URL, logger, slowQueryThresholdMs: 1 });

    await client.$disconnect();
    expect(typeof client.$connect).toBe('function');
  });
});
