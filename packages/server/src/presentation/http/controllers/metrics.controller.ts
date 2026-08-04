import { timingSafeEqual } from 'node:crypto';
import { type RequestHandler } from 'express';

import { type MetricsPort } from '@/application/platform/ports/metrics.port.js';

export interface MetricsControllerDependencies {
  readonly metrics: MetricsPort;
  /** Required whenever the endpoint is mounted; the env schema refuses the combination without it. */
  readonly token: string;
}

/**
 * Compares two secrets without leaking their prefix through timing.
 *
 * `===` on a token returns as soon as the first byte differs, so an attacker who can measure the
 * response learns the secret one character at a time. The length is compared first because
 * `timingSafeEqual` throws on differing lengths — that comparison does leak the length, which is
 * the one property a token generator makes uninteresting.
 */
const matches = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);

  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The exposition endpoint, behind a bearer token.
 *
 * `/metrics` describes the process to whoever scrapes it: route templates, status distribution,
 * heap, event-loop lag. None of it is user data — the labels are checked for that elsewhere — but
 * all of it is a map of the installation, and a self-hosted product cannot assume the port is only
 * reachable from a trusted network.
 *
 * 404 rather than 401 for a wrong token: an unauthenticated caller learns nothing, not even that
 * the endpoint exists here. The same reasoning the API uses for a resource in another organization
 * (CLAUDE.md, invariant 2).
 */
export const createMetricsController = (
  dependencies: MetricsControllerDependencies,
): { readonly render: RequestHandler } => ({
  render: async (request, response) => {
    const header = request.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

    if (!matches(presented, dependencies.token)) {
      response.status(404).end();
      return;
    }

    response.type(dependencies.metrics.contentType).send(await dependencies.metrics.render());
  },
});
