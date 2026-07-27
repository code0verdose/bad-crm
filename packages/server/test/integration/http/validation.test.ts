import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { denyAccess } from '../../../src/domain/shared/errors/access-denial.util.js';
import { RateLimitedError } from '../../../src/domain/shared/errors/app.errors.js';
import { validate } from '../../../src/presentation/http/middleware/validate.middleware.js';
import { createProbeApp, PROBE_REQUEST_ID, type ProbeApp } from './probe-app.util.js';

interface ProblemBody {
  type?: string;
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: { path: string; code: string; message: string }[];
}

/** `POST /things/:thingId` validating all three sources, plus the routes the edge cases need. */
const probeApp = (): ProbeApp => {
  const createThing = validate({
    params: z.object({ thingId: z.uuid() }),
    query: z.object({ page: z.coerce.number().int().positive().default(1) }),
    body: z.object({
      title: z.string().min(1),
      amount: z.object({ value: z.number(), currency: z.string() }),
    }),
  });
  const listThings = validate({
    query: z.object({ page: z.coerce.number().int().positive(), enabled: z.stringbool() }),
  });

  return createProbeApp((router) => {
    router.post('/things/:thingId', createThing.handler, (_request, response) => {
      response.json(createThing.read(response));
    });

    router.get('/things', listThings.handler, (_request, response) => {
      const { query } = listThings.read(response);

      response.json({ page: query.page, pageType: typeof query.page, enabled: query.enabled });
    });

    router.get('/things/foreign', () => {
      throw denyAccess('task', 'other_organization');
    });

    router.get('/things/denied', () => {
      throw denyAccess('task', 'own_organization');
    });

    router.get('/things/throttled', () => {
      throw new RateLimitedError(30);
    });

    router.get('/things/broken', () => {
      throw new Error('column "organization_id" does not exist');
    });
  });
};

const VALID_ID = '3f1c2b4e-9a5d-4c7b-8e21-6d0f5a7c9b34';

describe('a rejected request names every field that was wrong', () => {
  it('answers 422 as a problem document with one entry per invalid field', async () => {
    const response = await request(probeApp().app)
      .post(`/things/${VALID_ID}`)
      .send({ title: '', amount: { value: '10', currency: 'EUR' } });
    const body = response.body as ProblemBody;

    expect(response.status).toBe(422);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(body.code).toBe('validation_failed');
    expect(body.errors).toHaveLength(2);
    for (const issue of body.errors ?? []) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'message', 'path']);
    }
  });

  it('points at a nested field in dot notation', async () => {
    const response = await request(probeApp().app)
      .post(`/things/${VALID_ID}`)
      .send({ title: 'ok', amount: { value: '10', currency: 'EUR' } });
    const body = response.body as ProblemBody;

    expect(body.errors).toEqual([
      { path: 'amount.value', code: 'invalid_type', message: expect.any(String) as unknown },
    ]);
  });

  /**
   * `z.coerce.number()` turns `'abc'` into `NaN`, and `NaN` is a number as far as TypeScript is
   * concerned. Without a schema at the boundary the value travels into the use-case and surfaces
   * as a 500 somewhere down the call stack — or worse, as `LIMIT NaN`.
   */
  it('rejects an uncoercible query parameter at the boundary instead of passing NaN inwards', async () => {
    const response = await request(probeApp().app).get('/things?page=abc&enabled=true');
    const body = response.body as ProblemBody;

    expect(response.status).toBe(422);
    expect(body.errors?.map((issue) => issue.path)).toEqual(['page']);
  });

  it('reports failures of the params, the query and the body in one response', async () => {
    const response = await request(probeApp().app)
      .post('/things/not-a-uuid?page=0')
      .send({ title: '', amount: { value: 1, currency: 'EUR' } });
    const body = response.body as ProblemBody;

    expect(response.status).toBe(422);
    expect(body.errors?.map((issue) => issue.path).sort()).toEqual(['page', 'thingId', 'title']);
  });
});

describe('an accepted request arrives coerced', () => {
  it('hands the controller the parsed values, not the strings from the URL', async () => {
    const response = await request(probeApp().app).get('/things?page=3&enabled=false');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ page: 3, pageType: 'number', enabled: false });
  });

  it('applies a default the schema declares, so the controller never checks for undefined', async () => {
    const response = await request(probeApp().app)
      .post(`/things/${VALID_ID}`)
      .send({ title: 'ok', amount: { value: 10, currency: 'EUR' } });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      params: { thingId: VALID_ID },
      query: { page: 1 },
      body: { title: 'ok' },
    });
  });
});

describe('the shape of every problem document', () => {
  it('carries type, title, status, code and requestId', async () => {
    const response = await request(probeApp().app).get('/things/foreign');
    const body = response.body as ProblemBody;

    expect(body.type).toBe('https://bad-crm.dev/problems/task-not-found');
    expect(body.title).toBeTruthy();
    expect(body.status).toBe(404);
    expect(body.code).toBe('task_not_found');
    expect(body.requestId).toBe(PROBE_REQUEST_ID);
  });

  /**
   * `instance` is deliberately absent — see the decision recorded in `problem.serializer.ts`: this
   * product has routes whose path segment *is* the credential, and a problem document is the thing
   * a user pastes into a support ticket. The assertion is here so that adding the field back is a
   * failing test rather than a leak nobody notices.
   */
  it('omits instance, and identifies the occurrence by requestId alone', async () => {
    const response = await request(probeApp().app).get('/things/foreign');

    expect((response.body as ProblemBody).instance).toBeUndefined();
  });

  it('never carries detail on a 500', async () => {
    const response = await request(probeApp().app).get('/things/broken');
    const body = response.body as ProblemBody;

    expect(response.status).toBe(500);
    expect(body.detail).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('organization_id');
  });

  it('carries detail below 500, where it is our own sentence', async () => {
    const response = await request(probeApp().app).get('/things?page=abc&enabled=true');

    expect((response.body as ProblemBody).detail).toBeTruthy();
  });

  it('leaves errors out of a problem that is not about fields', async () => {
    const response = await request(probeApp().app).get('/things/foreign');

    expect((response.body as ProblemBody).errors).toBeUndefined();
  });

  it('answers an unmatched path with route_not_found rather than a resource code', async () => {
    const response = await request(probeApp().app).get('/nothing-here');
    const body = response.body as ProblemBody;

    expect(response.status).toBe(404);
    expect(body.code).toBe('route_not_found');
  });
});

/**
 * Invariant 2 of CLAUDE.md at the HTTP boundary. The two routes differ only in the scope of the
 * denial, and that single input has to be the whole difference between "this does not exist" and
 * "you may not do this" — otherwise the API answers, to anyone who asks, which ids exist in
 * organizations they cannot see.
 */
describe('a denial across organizations is indistinguishable from a missing resource', () => {
  it('answers 404 task_not_found for a resource of another organization', async () => {
    const response = await request(probeApp().app).get('/things/foreign');

    expect(response.status).toBe(404);
    expect((response.body as ProblemBody).code).toBe('task_not_found');
    expect(JSON.stringify(response.body)).not.toContain('forbidden');
  });

  it('answers 403 task_forbidden only inside the caller own organization', async () => {
    const response = await request(probeApp().app).get('/things/denied');

    expect(response.status).toBe(403);
    expect((response.body as ProblemBody).code).toBe('task_forbidden');
  });
});

describe('throttling', () => {
  it('answers 429 rate_limited with Retry-After, so a client knows when to come back', async () => {
    const response = await request(probeApp().app).get('/things/throttled');

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('30');
    expect((response.body as ProblemBody).code).toBe('rate_limited');
  });
});

describe('log levels of a rejected request', () => {
  it('logs a 422 at warn, without a stack', async () => {
    const probe = probeApp();

    await request(probe.app).get('/things?page=abc&enabled=true');

    const entry = probe
      .logLines()
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line['code'] === 'validation_failed');

    expect(entry?.['level']).toBe(40);
    expect(JSON.stringify(entry)).not.toContain('stack');
  });
});
