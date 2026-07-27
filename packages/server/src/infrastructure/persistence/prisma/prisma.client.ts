import { type Prisma, PrismaClient } from '@prisma/client';

import { type LoggerPort } from '@/application/platform/ports/logger.port.js';

/**
 * Above this, a statement is worth a line in the log. Chosen against the role-level
 * `statement_timeout = '5s'` of `app_user`: a query at 200 ms is not yet failing but is already the
 * kind that turns into a timeout under load, which is the moment it is cheap to find.
 */
export const SLOW_QUERY_THRESHOLD_MS = 200;

const QUERY_EVENT_LOG = [{ emit: 'event', level: 'query' }] as const;

export interface CreatePrismaClientOptions {
  readonly url: string;
  readonly logger: LoggerPort;
  readonly slowQueryThresholdMs?: number;
}

/**
 * Logs the statement, never its parameters.
 *
 * `event.query` is the SQL with `$1` placeholders — safe, and the only part that identifies which
 * query was slow. `event.params` is the bound values: password hashes, refresh-token hashes,
 * encrypted blobs, personal data. It is not redacted here, it is simply never read
 * (CLAUDE.md, «Что нельзя логировать никогда»).
 */
export const createSlowQueryLogger =
  (logger: LoggerPort, thresholdMs: number) =>
  (event: Prisma.QueryEvent): void => {
    if (event.duration < thresholdMs) return;

    logger.warn(
      { event: 'db.query.slow', durationMs: event.duration, query: event.query },
      'slow database query',
    );
  };

/**
 * The one place a `PrismaClient` is constructed.
 *
 * It hands back the bare client: the composition root wraps it in `guardedClient` for everything
 * except `withTenant`, and keeps this instance as the single object to `$disconnect` on shutdown.
 * Two clients would mean two pools, two connection limits and a shutdown that closes one of them.
 */
export const createPrismaClient = ({
  url,
  logger,
  slowQueryThresholdMs = SLOW_QUERY_THRESHOLD_MS,
}: CreatePrismaClientOptions): PrismaClient => {
  const client = new PrismaClient({ datasourceUrl: url, log: [...QUERY_EVENT_LOG] });

  client.$on('query', createSlowQueryLogger(logger, slowQueryThresholdMs));

  return client;
};
