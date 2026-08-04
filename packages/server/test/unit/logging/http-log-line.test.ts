/**
 * What the completion line of a request actually contains — asserted against the bytes pino writes.
 *
 * The middleware replaces `pino-http`'s default serializers, which would otherwise write `req.url`
 * and the full header set. Both halves of that are load-bearing and neither had a test: the URL of a
 * protected link **is** the credential (`docs/security/threat-model.md`, T-IAM-07), and a request
 * body is user content. The serializers were right; nothing proved they stayed right, and the next
 * person to want a URL in a log line would have found no failing test to argue with.
 *
 * Everything here runs at `debug`, because that is the level the claim is about: raising verbosity
 * must not open the body (`rules/observability.mdc`, «LOG_LEVEL=debug»).
 */
import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { AsyncRequestContextAdapter } from '../../../src/infrastructure/logging/async-request-context.adapter.js';
import { createHttpLogger } from '../../../src/infrastructure/logging/http-logger.middleware.js';
import { createRootLogger } from '../../../src/infrastructure/logging/pino-logger.adapter.js';

const SECRET_IN_URL = 'example-only-not-a-real-link-token';
const SECRET_IN_BODY = 'example-only-not-a-real-password';

const capturingDestination = () => {
  const written: string[] = [];

  return { write: (line: string) => written.push(line), lines: () => written };
};

const appWritingTo = (destination: { write: (line: string) => void }): Express => {
  const application = express();
  const requestContext = new AsyncRequestContextAdapter();

  application.use(express.json());
  // The real pair: the identifier comes from the context the request runs inside, so the completion
  // line and every line within it carry one value rather than two competing ones.
  application.use((_request, _response, next) => {
    requestContext.run(
      {
        requestId: 'req-under-test',
        organizationId: 'org-under-test',
        userId: 'user-under-test',
      },
      next,
    );
  });
  application.use(
    createHttpLogger({
      // `requestContext` goes to **both**: `createHttpLogger` reuses the identifier for the
      // completion line, and the root logger mixes `requestId`/`organizationId`/`userId` into every
      // line from the same storage. Wiring only one of them writes a line with none of the three —
      // which is what the first version of this file did, and it read like a defect in the product.
      logger: createRootLogger({ level: 'debug', version: '0.0.0', requestContext }, destination),
      requestContext,
    }),
  );
  application.post('/api/v1/auth/login', (_request, response) => {
    response.status(204).end();
  });
  application.get('/s/:token', (_request, response) => {
    response.status(204).end();
  });

  return application;
};

describe('the request log line', () => {
  it('carries the fields an incident is reconstructed from', async () => {
    const destination = capturingDestination();

    await request(appWritingTo(destination))
      .post('/api/v1/auth/login')
      .send({ email: 'ada@example.com', password: SECRET_IN_BODY });

    const completion = destination
      .lines()
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line['msg'] === 'request completed');

    expect(completion).toMatchObject({
      requestId: 'req-under-test',
      organizationId: 'org-under-test',
      userId: 'user-under-test',
      route: '/api/v1/auth/login',
      res: { statusCode: 204 },
      durationMs: expect.any(Number) as unknown as number,
    });
  });

  it.each([
    ['a password in the body', '/api/v1/auth/login', SECRET_IN_BODY],
    ['a token in the path', `/s/${SECRET_IN_URL}`, SECRET_IN_URL],
  ])('never writes %s, even at debug level', async (_case, path, secret) => {
    const destination = capturingDestination();
    const application = appWritingTo(destination);

    await (path.startsWith('/s/')
      ? request(application).get(path)
      : request(application).post(path).send({ email: 'ada@example.com', password: secret }));

    expect(destination.lines().join('\n')).not.toContain(secret);
  });

  /**
   * CONTROL: the assertions above are «this string is absent», which is what an empty log also
   * satisfies. This one proves the logger wrote something, that the something is JSON, and that a
   * value which is *supposed* to be there can be found by the same search — so «absent» means
   * absent rather than «looked in the wrong place».
   */
  it('CONTROL: writes a line, and a non-secret value in it is findable', async () => {
    const destination = capturingDestination();

    await request(appWritingTo(destination)).post('/api/v1/auth/login').send({ email: 'a@b.co' });

    expect(destination.lines().length).toBeGreaterThan(0);
    expect(destination.lines().join('\n')).toContain('/api/v1/auth/login');
  });

  /**
   * The route **template**, not the path: `/s/:token` identifies the endpoint without carrying the
   * credential in it. A logger that recorded the concrete path would defeat every assertion above
   * on the one route where it matters most.
   */
  it('records the route template rather than the path that was requested', async () => {
    const destination = capturingDestination();

    await request(appWritingTo(destination)).get(`/s/${SECRET_IN_URL}`);

    const completion = destination
      .lines()
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line['msg'] === 'request completed');

    expect(completion?.['route']).toBe('/s/:token');
  });
});
