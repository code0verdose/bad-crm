import { describe, expect, it, vi } from 'vitest';

import { RateLimitedError } from '../../../src/domain/shared/errors/app.errors.js';
import {
  type LogFields,
  type LoggerPort,
} from '../../../src/application/platform/ports/logger.port.js';
import { type RateLimitPort } from '../../../src/application/platform/ports/rate-limit.port.js';
import { RecordClientErrorUseCase } from '../../../src/application/platform/use-cases/record-client-error.use-case.js';

const REPORT = {
  message: 'Cannot read properties of undefined',
  stack: 'TypeError: Cannot read properties of undefined\n    at TaskCard (index-4f2a.js:1:2843)',
  appVersion: '0.0.0',
  route: '/_authenticated/dashboard',
  reference: '4f2a91cd',
  requestId: 'req-7',
};

const recordingLogger = (): {
  logger: LoggerPort;
  warnings: { fields: LogFields; message: string }[];
} => {
  const warnings: { fields: LogFields; message: string }[] = [];
  const logger: LoggerPort = {
    debug: () => undefined,
    info: () => undefined,
    warn: (fields, message) => warnings.push({ fields, message }),
    error: () => undefined,
    child: () => logger,
  };

  return { logger, warnings };
};

const limiterAllowing = (allowed: boolean): RateLimitPort =>
  ({
    consume: vi.fn().mockResolvedValue({ allowed, retryAfterSeconds: allowed ? 0 : 42 }),
    reset: vi.fn(),
  }) as unknown as RateLimitPort;

describe('recording a browser failure', () => {
  /**
   * `source: 'client'` is the whole reason the field exists. Without it a stack from a bundle sits
   * beside a stack from the server and reads as a server failure, and the operator chases a backend
   * bug that never happened.
   */
  it('writes it to the log, marked as coming from a browser', async () => {
    const { logger, warnings } = recordingLogger();

    await new RecordClientErrorUseCase(limiterAllowing(true), logger).execute(REPORT, {
      userId: 'user-1',
      ipAddress: '203.0.113.4',
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({
      source: 'client',
      reference: '4f2a91cd',
      appVersion: '0.0.0',
      route: '/_authenticated/dashboard',
      clientMessage: REPORT.message,
      clientStack: REPORT.stack,
      clientRequestId: 'req-7',
    });
  });

  /**
   * `warn`, not `error`. An error in this log means *this process* failed; it did exactly what it
   * was asked. Logging at `error` would make the metric that says «the API is unhealthy» respond to
   * a broken button in somebody's browser.
   */
  it('does not raise the error rate of the server', async () => {
    const { logger, warnings } = recordingLogger();
    const errors: unknown[] = [];
    const watchful: LoggerPort = { ...logger, error: (fields) => errors.push(fields) };

    await new RecordClientErrorUseCase(limiterAllowing(true), watchful).execute(REPORT, {
      userId: undefined,
      ipAddress: '203.0.113.4',
    });

    expect(warnings).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it('leaves out the fields the report did not carry', async () => {
    const { logger, warnings } = recordingLogger();

    await new RecordClientErrorUseCase(limiterAllowing(true), logger).execute(
      { ...REPORT, stack: undefined, requestId: undefined },
      { userId: undefined, ipAddress: undefined },
    );

    expect(warnings[0]?.fields).not.toHaveProperty('clientStack');
    expect(warnings[0]?.fields).not.toHaveProperty('clientRequestId');
  });

  /**
   * A tab in a render loop reports the same failure on every frame. The limiter is what stops one
   * broken component from writing a thousand lines into the log of an installation that has no idea
   * why — and the refusal carries the wait, so the client is not told to come back immediately.
   */
  it('refuses once the reporter has spent its budget', async () => {
    const { logger, warnings } = recordingLogger();
    const useCase = new RecordClientErrorUseCase(limiterAllowing(false), logger);

    await expect(
      useCase.execute(REPORT, { userId: 'user-1', ipAddress: undefined }),
    ).rejects.toThrow(RateLimitedError);
    expect(warnings).toHaveLength(0);
  });

  /**
   * Counted per user when there is a session and per address otherwise — a shared exit node must not
   * spend one person's budget on everybody behind it, and a signed-in reporter must not be able to
   * dodge the limit by changing address.
   */
  it('counts against the reporter it was given', async () => {
    const limiter = limiterAllowing(true);
    const { logger } = recordingLogger();

    await new RecordClientErrorUseCase(limiter, logger).execute(REPORT, {
      userId: 'user-1',
      ipAddress: '203.0.113.4',
    });

    expect(limiter.consume).toHaveBeenCalledWith('client_error_report', {
      userId: 'user-1',
      ipAddress: '203.0.113.4',
    });
  });
});
