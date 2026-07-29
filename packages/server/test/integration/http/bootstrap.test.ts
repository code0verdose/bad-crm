import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createTestApp } from '../../support/test-app.util.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('GET /health — liveness', () => {
  it('answers 200 with the process status assembled from the use-case result', async () => {
    const { app } = createTestApp();

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'alive', version: expect.any(String) as string });
    expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(response.headers['content-type']).toContain('application/json');
  });

  /**
   * Liveness must not depend on readiness: a process that is draining is still alive, and telling
   * the container manager otherwise gets it killed mid-shutdown, cutting the in-flight requests
   * that graceful shutdown exists to protect.
   */
  it('keeps answering 200 while the process is shutting down', async () => {
    const { app, container } = createTestApp();

    container.lifecycle.beginShutdown();

    await expect(
      request(app)
        .get('/health')
        .then((r) => r.status),
    ).resolves.toBe(200);
  });
});

describe('GET /ready — readiness', () => {
  it('answers 200 when the process may receive traffic', async () => {
    const { app } = createTestApp();

    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ready: true, shuttingDown: false });
  });

  /**
   * `rules/observability.mdc`, rule 13: the optional services this installation does not run are
   * named in the body and do not change the status — otherwise the `minimal` profile could never
   * become ready.
   */
  it('names the disabled optional services without failing because of them', async () => {
    const { app } = createTestApp({ MEILI_HOST: undefined, SMTP_URL: undefined });

    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body.dependencies).toMatchObject({
      search: { status: 'disabled', detail: 'postgres-fts' },
      mail: { status: 'disabled', detail: 'unavailable' },
    });
  });

  /**
   * Authentication is in the same body for the opposite reason: it is not optional, and an
   * installation without `DATABASE_AUTH_URL` answers 500 to the first sign-in while every probe
   * says the container is fine. The field is what makes that visible before a user finds it.
   *
   * It does **not** change the status. A `/ready` that failed here would take the instance out of
   * rotation entirely, and the operator would lose the working half of the installation along with
   * the sign-in they cannot use anyway — the same reasoning as rule 13 of
   * `rules/observability.mdc`. The `warn` line at startup is the part that demands attention.
   */
  it('names the authentication pool as unavailable when DATABASE_AUTH_URL is absent', async () => {
    const { app } = createTestApp({ DATABASE_AUTH_URL: undefined });

    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body.dependencies).toMatchObject({
      authentication: { status: 'disabled', detail: 'unavailable' },
    });
  });

  it('answers 503 once shutdown has begun, so the load balancer stops routing here', async () => {
    const { app, container } = createTestApp();

    container.lifecycle.beginShutdown();
    const response = await request(app).get('/ready');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ ready: false, shuttingDown: true });
  });
});

describe('request identity', () => {
  it('generates a ULID when the client sent no x-request-id', async () => {
    const { app } = createTestApp();

    const response = await request(app).get('/health');

    expect(response.headers['x-request-id']).toMatch(ULID);
  });

  it('keeps the identifier a reverse proxy already assigned', async () => {
    const { app } = createTestApp();

    const response = await request(app)
      .get('/health')
      .set('x-request-id', '01J8Z2F5Q3K9V6N0R4T7YB3XQD');

    expect(response.headers['x-request-id']).toBe('01J8Z2F5Q3K9V6N0R4T7YB3XQD');
  });

  it('writes the identifier, the route template and the timing into the completion line', async () => {
    const { app, logLines } = createTestApp();

    await request(app).get('/health').set('x-request-id', '01J8Z2F5Q3K9V6N0R4T7YB3XQD');

    const completion = logLines()
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry['route'] === '/health' && entry['statusCode'] === 200);

    expect(completion).toBeDefined();
    expect(completion).toMatchObject({
      requestId: '01J8Z2F5Q3K9V6N0R4T7YB3XQD',
      route: '/health',
      statusCode: 200,
      organizationId: null,
      userId: null,
    });
    expect(completion?.['durationMs']).toEqual(expect.any(Number));
  });

  /**
   * Found on a running process, not in review: pino-http evaluates `customProps` both when the
   * request arrives and when it completes, and merges both into one line — so the completion line
   * carried `route` and `statusCode` twice, the first copy holding the pre-routing state
   * (`"route":"unmatched","statusCode":200` in front of the real values). Any consumer that keeps
   * the first occurrence of a duplicate JSON key — and `grep -o` does — then reads a status the
   * request never returned.
   */
  it('writes route and statusCode once per line, with the values of the finished request', async () => {
    const { app, logLines } = createTestApp();

    await request(app).get('/api/v1/does-not-exist');

    const completion = logLines().find((line) => line.includes('request completed')) ?? '';

    expect(completion.match(/"route":/g)).toHaveLength(1);
    // The stale copy would say 200, because it is produced before the request is routed at all.
    expect(completion).not.toContain('"statusCode":200');
    expect(JSON.parse(completion)).toMatchObject({ route: 'unmatched', statusCode: 404 });
  });

  it('never logs the Authorization header, even at debug level', async () => {
    const { app, logLines } = createTestApp({ LOG_LEVEL: 'debug' });

    await request(app).get('/health').set('authorization', 'Bearer s3cr3t-token');

    expect(logLines().join('\n')).not.toContain('s3cr3t-token');
  });
});

describe('HTTP hardening', () => {
  /**
   * ADR-0023. Each of these three would pass a "does the header exist" check and break the product
   * in a browser: no WASM means the vault never unlocks, a missing storage origin means attachments
   * do not render, and `require-corp` blocks every presigned image.
   */
  it('ships a CSP that lets the WASM crypto module compile', async () => {
    const { app } = createTestApp();

    const csp = (await request(app).get('/health')).headers['content-security-policy'];

    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('puts the configured object storage origin into connect-src and img-src', async () => {
    const { app } = createTestApp({ S3_ENDPOINT: 'https://s3.example.com/bad-crm' });

    const csp = (await request(app).get('/health')).headers['content-security-policy'];

    expect(csp).toContain('connect-src');
    expect(csp).toContain('https://s3.example.com');
  });

  it('does not set Cross-Origin-Embedder-Policy, which would break presigned attachments', async () => {
    const { app } = createTestApp();

    const response = await request(app).get('/health');

    expect(response.headers['cross-origin-embedder-policy']).toBeUndefined();
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it.each([
    ['x-content-type-options', 'nosniff'],
    // `no-referrer`, and the previous value — helmet's `strict-origin-when-cross-origin` — was a
    // live token leak, not a stylistic preference.
    //
    // `docs/security/threat-model.md` T-IAM-07 (impact «Выс.») prescribes this header by name for
    // the reset page, and the delta that put the reset token in the *path* cites T-IAM-07 six times
    // as the reason. But `strict-origin-when-cross-origin` sends «the origin, path, and query
    // string» on a **same-origin** request, so the path is no safer than a query string: opening
    // `/reset-password/<token>` makes the browser send `Referer: …/reset-password/<token>` on every
    // same-origin asset and on `POST /api/v1/auth/reset-password`. `docs/runbooks/install.md` has
    // the operator put their own reverse proxy in front, and nginx's stock `combined` format logs
    // `$http_referer` — so a live, unspent token lands in an access log for up to its whole TTL,
    // readable by anyone with log access, and it is enough to take the account over.
    //
    // It is set globally rather than on the reset route because there is no per-route document: the
    // SPA serves one `index.html` for every path, so a route-scoped response header cannot exist.
    // Nothing here needs a referrer — there is no analytics and no cross-origin consumer of one.
    ['referrer-policy', 'no-referrer'],
    // Agrees with `frame-ancestors 'none'`; helmet's default SAMEORIGIN would not, and a browser
    // that only understands X-Frame-Options would follow the weaker of the two.
    ['x-frame-options', 'DENY'],
  ])('sets %s', async (header, value) => {
    const { app } = createTestApp();

    expect((await request(app).get('/health')).headers[header]).toBe(value);
  });

  it('does not advertise the framework', async () => {
    const { app } = createTestApp();

    expect((await request(app).get('/health')).headers['x-powered-by']).toBeUndefined();
  });

  it('sends HSTS when the installation is served over https', async () => {
    const { app } = createTestApp({ APP_URL: 'https://crm.example.com' });

    expect((await request(app).get('/health')).headers['strict-transport-security']).toContain(
      'max-age=',
    );
  });

  it('omits HSTS on a plain-http development installation, where it would lock out localhost', async () => {
    const { app } = createTestApp({ APP_URL: 'http://localhost:3000', NODE_ENV: 'development' });

    expect(
      (await request(app).get('/health')).headers['strict-transport-security'],
    ).toBeUndefined();
  });
});

describe('CORS', () => {
  it('answers a configured origin with credentials allowed', async () => {
    const { app } = createTestApp({ APP_URL: 'https://crm.example.com' });

    const response = await request(app).get('/health').set('origin', 'https://crm.example.com');

    expect(response.headers['access-control-allow-origin']).toBe('https://crm.example.com');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('accepts an extra origin the installation configured', async () => {
    const { app } = createTestApp({ CORS_EXTRA_ORIGINS: 'https://desktop.example.com' });

    const response = await request(app).get('/health').set('origin', 'https://desktop.example.com');

    expect(response.headers['access-control-allow-origin']).toBe('https://desktop.example.com');
  });

  it('sends no allow-origin header to a foreign origin, so the browser blocks the response', async () => {
    const { app } = createTestApp();

    const response = await request(app).get('/health').set('origin', 'https://evil.example.com');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('request body limits', () => {
  /**
   * Files never travel through Node (ADR-0015): uploads go straight to S3 over a presigned URL. A
   * multi-megabyte JSON body is therefore always a defect or an attack, and it is refused with a
   * stable code rather than by whatever body-parser happens to throw.
   */
  it('refuses a body over 1 MB with 413 and a stable code', async () => {
    const { app } = createTestApp();

    const response = await request(app)
      .post('/api/v1/nowhere')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ note: 'x'.repeat(1_200_000) }));

    expect(response.status).toBe(413);
    expect(response.body.code).toBe('payload_too_large');
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('answers malformed JSON with 422 instead of the parser default', async () => {
    const { app } = createTestApp();

    const response = await request(app)
      .post('/api/v1/nowhere')
      .set('content-type', 'application/json')
      .send('{"note": ');

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('validation_failed');
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('accepts a small body, so the limit is a limit and not a wall', async () => {
    const { app } = createTestApp();

    const response = await request(app)
      .post('/api/v1/nowhere')
      .send({ note: 'x'.repeat(100) });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('route_not_found');
  });
});

describe('unmatched routes', () => {
  it('answers a problem document with a code of its own, not a resource code', async () => {
    const { app } = createTestApp();

    const response = await request(app).get('/api/v1/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({
      code: 'route_not_found',
      status: 404,
    });
    expect(response.body.requestId).toMatch(ULID);
    // No `instance`: the URL is the one field of a problem document this product cannot print,
    // because `/l/:token` puts a credential in the path. See problem.serializer.ts.
    expect(response.body).not.toHaveProperty('instance');
  });
});
