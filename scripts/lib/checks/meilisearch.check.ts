import type { CheckOutcome, ServiceCheck } from '../service-check.types.js';
import { DEV_STACK_REMEDY, withTransportFailure } from './transport.util.js';

/**
 * `GET /health` of Meilisearch — an unauthenticated endpoint by design, so the master key is
 * neither sent nor printed.
 *
 * Optional on purpose: without Meilisearch `SearchPort` falls back to PostgreSQL FTS (ADR-0011),
 * and the `minimal` profile does not start the container at all.
 */

export const interpretMeiliHealth = (status: number, body: string): CheckOutcome => {
  if (status !== 200) {
    return {
      status: 'failed',
      details: [`/health answered HTTP ${status}`],
      remedy: 'inspect the container with `docker compose logs meilisearch`',
    };
  }

  const reported = ((): string | undefined => {
    try {
      const parsed: unknown = JSON.parse(body);
      const value = (parsed as { status?: unknown } | null)?.status;

      return typeof value === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  })();

  if (reported === 'available') return { status: 'ok', details: ['/health reports available'] };

  return {
    status: 'failed',
    details: [
      reported === undefined
        ? '/health answered 200 with a body that is not the expected Meilisearch JSON'
        : `/health reports "${reported}" instead of "available"`,
    ],
    remedy: 'wait for the index to load, then re-run; otherwise `docker compose logs meilisearch`',
  };
};

export const createMeilisearchCheck = (options: {
  readonly host: string;
  readonly get: (url: URL) => Promise<{ status: number; body: string }>;
}): ServiceCheck => {
  const url = new URL('/health', options.host);

  return {
    service: 'meilisearch',
    requirement: 'optional',
    target: url.toString(),
    run: async () =>
      withTransportFailure(DEV_STACK_REMEDY, async () => {
        const response = await options.get(url);

        return interpretMeiliHealth(response.status, response.body);
      }),
  };
};
