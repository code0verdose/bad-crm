import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createTestApp } from '../../support/test-app.util.js';

const TOKEN = 'example-only-not-a-real-metrics-token-0123456789';

/**
 * The switch, exercised through the real composition rather than through the adapters.
 *
 * The adapters are tested on their own; what this file asserts is the wiring between the
 * environment and the running application — that `METRICS_ENABLED=false` produces an installation
 * with no exposition surface at all, and that turning it on mounts the endpoint, guards it, and
 * puts the collector in front of the request chain.
 */
describe('an installation with metrics switched off', () => {
  it('has no /metrics endpoint to find', async () => {
    const { app } = createTestApp();

    const response = await request(app).get('/metrics').set('authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(404);
    expect(response.text).not.toContain('http_requests_total');
  });

  /** CONTROL: the application is otherwise alive, so the 404 above is about the endpoint. */
  it('CONTROL: still answers its liveness probe', async () => {
    await expect(request(createTestApp().app).get('/health')).resolves.toMatchObject({
      status: 200,
    });
  });
});

describe('an installation with metrics switched on', () => {
  const enabled = () => createTestApp({ METRICS_ENABLED: true, METRICS_TOKEN: TOKEN });

  it('answers the exposition text to a caller holding the token', async () => {
    const response = await request(enabled().app)
      .get('/metrics')
      .set('authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.text).toContain('nodejs_eventloop_lag_seconds');
  });

  it('answers 404 without the token, so the endpoint cannot be confirmed to exist', async () => {
    await expect(request(enabled().app).get('/metrics')).resolves.toMatchObject({ status: 404 });
  });

  /**
   * The collector has to be in the chain, not merely constructed. Asserted by making a request to
   * an ordinary endpoint and then reading the exposition text — the only way to tell «wired» from
   * «built and forgotten», which is what the first version of this wiring would have been.
   */
  it('counts a request that went through the application', async () => {
    const { app } = enabled();

    await request(app).get('/health');

    const rendered = await request(app).get('/metrics').set('authorization', `Bearer ${TOKEN}`);

    expect(rendered.text).toContain('route="/health"');
    expect(rendered.text).toContain('http_request_duration_seconds_count');
  });
});
