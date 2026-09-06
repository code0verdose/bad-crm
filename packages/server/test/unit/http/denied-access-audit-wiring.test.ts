/**
 * The error handler is the one place every refusal passes through, so it is the one place that can
 * hand a refusal to the trail without every future `assertAllowed` having to remember to.
 *
 * This suite drives the real handler through a real route and asserts on the facts it hands over —
 * not on a row, which is the service's own suite. What it protects is the wiring: a service nobody
 * calls is the failure mode a unit test of the service cannot see.
 */
import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { type DeniedAccess } from '../../../src/application/access/use-cases/record-denied-access.use-case.js';
import { type RequestContextPort } from '../../../src/application/platform/ports/request-context.port.js';
import { assertAllowed, deny } from '../../../src/domain/access/decision.util.js';
import { NotFoundError } from '../../../src/domain/shared/errors/app.errors.js';
import { AsyncRequestContextAdapter } from '../../../src/infrastructure/logging/async-request-context.adapter.js';
import {
  createRootLogger,
  PinoLoggerAdapter,
} from '../../../src/infrastructure/logging/pino-logger.adapter.js';
import { createErrorHandler } from '../../../src/presentation/http/error-handler.middleware.js';
import { createRequestContextMiddleware } from '../../../src/presentation/http/middleware/request-context.middleware.js';

const CALLER = {
  organizationId: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
  userId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
};

interface Probe {
  readonly app: Express;
  readonly recorded: DeniedAccess[];
}

const appRefusing = (handler: RequestHandler, identify = true): Probe => {
  const logger = createRootLogger(
    { level: 'silent', version: '0.0.0' },
    { write: () => undefined },
  );
  const requestContext = new AsyncRequestContextAdapter();
  const recorded: DeniedAccess[] = [];
  const app = express();

  app.use(
    createRequestContextMiddleware({
      requestContext,
      idGenerator: { next: () => '01J8Z2F5Q3K9V6N0R4T7YB3XQD' },
    }),
  );
  app.use((_request, _response, next) => {
    if (identify) requestContext.identify(CALLER);
    next();
  });
  app.all('/guarded', handler);
  app.use(
    createErrorHandler({
      logger: new PinoLoggerAdapter(logger),
      requestContext,
      deniedAccessAudit: {
        record: (denial: DeniedAccess): void => {
          recorded.push(denial);
        },
      },
    }),
  );

  return { app, recorded };
};

describe('the error handler hands a refusal to the denial trail', () => {
  it('passes the reason, the permission key, the method and the caller', async () => {
    const { app, recorded } = appRefusing(() => {
      assertAllowed(deny('permission_not_granted', 'role:assign'), 'role');
    });

    const response = await request(app).post('/guarded');

    expect(response.status).toBe(403);
    expect(recorded).toEqual([
      {
        reason: 'permission_not_granted',
        permissionKey: 'role:assign',
        method: 'POST',
        actorUserId: CALLER.userId,
        organizationId: CALLER.organizationId,
        ipAddress: expect.any(String) as unknown as string,
        requestId: '01J8Z2F5Q3K9V6N0R4T7YB3XQD',
      },
    ]);
  });

  it('passes a refusal that names no permission key', async () => {
    const { app, recorded } = appRefusing(() => {
      assertAllowed(deny('not_the_owner'), 'organization');
    });

    await request(app).post('/guarded');

    expect(recorded[0]).toMatchObject({ reason: 'not_the_owner', permissionKey: undefined });
  });

  /**
   * CONTROL. Without it the suite passes for a handler that reports every failure as a refusal, and
   * «who was refused» would answer «everybody who mistyped a URL».
   */
  it('CONTROL: says nothing about a failure that is not a refusal', async () => {
    const { app, recorded } = appRefusing(() => {
      throw new NotFoundError('task_not_found');
    });

    await request(app).post('/guarded');

    expect(recorded).toEqual([]);
  });

  /**
   * CONTROL. A refusal before the authentication guard has resolved anybody has no tenant to write
   * under; the handler must not invent one, and the counter is what covers that case.
   */
  it('CONTROL: says nothing when no caller has been identified', async () => {
    const { app, recorded } = appRefusing(() => {
      assertAllowed(deny('not_authenticated'), 'user');
    }, false);

    const response = await request(app).post('/guarded');

    expect(response.status).toBe(401);
    expect(recorded).toEqual([]);
  });

  it('CONTROL: a request that succeeds records nothing', async () => {
    const { app, recorded } = appRefusing((_request, response) => {
      response.status(204).end();
    });

    await request(app).post('/guarded');

    expect(recorded).toEqual([]);
  });

  /**
   * The two halves of «there is a caller» are checked separately, so both have to be exercised
   * separately. A context that names a user but no organization cannot arise through `identify`,
   * which takes them together — which is exactly why the guard has to be written by hand here: the
   * day a second way of filling the context appears, this is what refuses to file an entry with no
   * tenant to file it under.
   */
  it('CONTROL: says nothing when the context names a user but no organization', async () => {
    const logger = createRootLogger(
      { level: 'silent', version: '0.0.0' },
      { write: () => undefined },
    );
    const recorded: DeniedAccess[] = [];
    const halfIdentified: RequestContextPort = {
      run: (_context, fn) => fn(),
      identify: () => undefined,
      current: () => ({
        requestId: '01J8Z2F5Q3K9V6N0R4T7YB3XQD',
        userId: CALLER.userId,
        organizationId: null,
      }),
    };
    const app = express();

    app.all('/guarded', () => {
      assertAllowed(deny('permission_not_granted', 'role:assign'), 'role');
    });
    app.use(
      createErrorHandler({
        logger: new PinoLoggerAdapter(logger),
        requestContext: halfIdentified,
        deniedAccessAudit: {
          record: (denial: DeniedAccess): void => {
            recorded.push(denial);
          },
        },
      }),
    );

    expect((await request(app).post('/guarded')).status).toBe(403);
    expect(recorded).toEqual([]);
  });

  /** And outside a request context altogether — a shape the port's own docstring allows. */
  it('CONTROL: says nothing when there is no request context at all', async () => {
    const logger = createRootLogger(
      { level: 'silent', version: '0.0.0' },
      { write: () => undefined },
    );
    const recorded: DeniedAccess[] = [];
    const contextless: RequestContextPort = {
      run: (_context, fn) => fn(),
      identify: () => undefined,
      current: () => undefined,
    };
    const app = express();

    app.all('/guarded', () => {
      assertAllowed(deny('permission_not_granted', 'role:assign'), 'role');
    });
    app.use(
      createErrorHandler({
        logger: new PinoLoggerAdapter(logger),
        requestContext: contextless,
        deniedAccessAudit: {
          record: (denial: DeniedAccess): void => {
            recorded.push(denial);
          },
        },
      }),
    );

    expect((await request(app).post('/guarded')).status).toBe(403);
    expect(recorded).toEqual([]);
  });

  it('survives an installation wired without the trail', async () => {
    const logger = createRootLogger(
      { level: 'silent', version: '0.0.0' },
      { write: () => undefined },
    );
    const requestContext = new AsyncRequestContextAdapter();
    const app = express();

    app.use(
      createRequestContextMiddleware({
        requestContext,
        idGenerator: { next: () => '01J8Z2F5Q3K9V6N0R4T7YB3XQD' },
      }),
    );
    app.all('/guarded', () => {
      assertAllowed(deny('permission_not_granted', 'role:assign'), 'role');
    });
    app.use(createErrorHandler({ logger: new PinoLoggerAdapter(logger), requestContext }));

    expect((await request(app).post('/guarded')).status).toBe(403);
  });

  it('does not let a failing sink change the response', async () => {
    const logger = createRootLogger(
      { level: 'silent', version: '0.0.0' },
      { write: () => undefined },
    );
    const requestContext = new AsyncRequestContextAdapter();
    const record = vi.fn(() => {
      throw new Error('the sink is broken');
    });
    const app = express();

    app.use(
      createRequestContextMiddleware({
        requestContext,
        idGenerator: { next: () => '01J8Z2F5Q3K9V6N0R4T7YB3XQD' },
      }),
    );
    app.use((_request, _response, next) => {
      requestContext.identify(CALLER);
      next();
    });
    app.all('/guarded', () => {
      assertAllowed(deny('permission_not_granted', 'role:assign'), 'role');
    });
    app.use(
      createErrorHandler({
        logger: new PinoLoggerAdapter(logger),
        requestContext,
        deniedAccessAudit: { record },
      }),
    );

    expect((await request(app).post('/guarded')).status).toBe(403);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
