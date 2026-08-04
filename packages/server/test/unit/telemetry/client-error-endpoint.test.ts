import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { RecordClientErrorUseCase } from '@/application/platform/use-cases/record-client-error.use-case.js';
import { createHttpServer } from '@/presentation/http/http-server.factory.js';

import { FakeRateLimit } from '../../support/identity-doubles.util.js';
import { createTestApp } from '../../support/test-app.util.js';

const REPORT = {
  message: 'Cannot read properties of undefined',
  appVersion: '0.0.0',
  route: '/_authenticated/dashboard',
  reference: '4f2a91cd',
};

/**
 * The endpoint through the real router: validation, status, and the line it leaves behind.
 *
 * Unauthenticated on purpose — the failures most worth hearing about include the ones that stop a
 * person signing in, and requiring a session would drop exactly those.
 */
const appWithLimiter = () => {
  const testApp = createTestApp();
  const rateLimit = new FakeRateLimit({});

  return {
    app: createHttpServer({
      ...testApp.container.http,
      recordClientError: new RecordClientErrorUseCase(rateLimit, testApp.container.logger),
    }),
    logLines: testApp.logLines,
    rateLimit,
  };
};

describe('POST /api/v1/telemetry/client-error', () => {
  it('accepts a report and answers with no body', async () => {
    const { app } = appWithLimiter();

    const response = await request(app).post('/api/v1/telemetry/client-error').send(REPORT);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
  });

  it('writes the report into the log, marked as coming from a browser', async () => {
    const { app, logLines } = appWithLimiter();

    await request(app).post('/api/v1/telemetry/client-error').send(REPORT);

    const line = logLines()
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((entry) => entry['msg'] === 'client error reported');

    expect(line).toMatchObject({ source: 'client', reference: '4f2a91cd' });
  });

  it('counts the report against the reporter', async () => {
    const { app, rateLimit } = appWithLimiter();

    await request(app).post('/api/v1/telemetry/client-error').send(REPORT);

    expect(rateLimit.consumed.map(({ policy }) => policy)).toEqual(['client_error_report']);
  });

  it.each([
    ['no message', { ...REPORT, message: undefined }],
    ['a reference too short to be one', { ...REPORT, reference: 'ab' }],
    ['a field the contract does not declare', { ...REPORT, password: 'nope' }],
  ])('refuses a report with %s', async (_case, body) => {
    const { app } = appWithLimiter();

    const response = await request(app).post('/api/v1/telemetry/client-error').send(body);

    expect(response.status).toBe(422);
  });

  /**
   * The limiter fails closed, and this endpoint inherits it deliberately: an unauthenticated route
   * that writes into the log must not accept traffic it cannot bound. An installation whose Redis is
   * unreachable stops collecting browser reports — which is the lesser harm, and it says so with a
   * 503 rather than by silently dropping them.
   */
  it('refuses reports when the counter store cannot be reached', async () => {
    const { app } = createTestApp();

    const response = await request(app).post('/api/v1/telemetry/client-error').send(REPORT);

    expect(response.status).toBe(503);
  });
});
