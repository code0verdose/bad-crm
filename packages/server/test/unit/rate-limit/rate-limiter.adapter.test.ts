import { beforeEach, describe, expect, it } from 'vitest';

import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';
import { rateLimitKeyOf } from '@/infrastructure/rate-limit/rate-limit-key.util.js';
import { RATE_LIMIT_POLICY } from '@/infrastructure/rate-limit/rate-limit-policy.constant.js';
import { RedisRateLimiterAdapter } from '@/infrastructure/rate-limit/rate-limiter.adapter.js';
import {
  type PolicyLimiters,
  type WindowLimiters,
} from '@/infrastructure/rate-limit/window-limiter.types.js';

import { FakeWindowLimiter } from './fake-window-limiter.util.js';
import { recordedValues, recordingLogger } from './recording-logger.util.js';

const SUBJECT = { ipAddress: '203.0.113.42', email: 'ada.lovelace@example.com' } as const;
const KEY = rateLimitKeyOf('auth_attempt', SUBJECT).value;

const AUTH = RATE_LIMIT_POLICY.auth_attempt;

interface Harness {
  readonly adapter: RedisRateLimiterAdapter;
  readonly attempts: FakeWindowLimiter;
  readonly penalties: FakeWindowLimiter;
  readonly lines: ReturnType<typeof recordingLogger>['lines'];
}

const harness = (): Harness => {
  const attempts = new FakeWindowLimiter(AUTH.points, AUTH.windowSeconds * 1000);
  // The penalty counter never rejects: it counts, it does not limit.
  const penalties = new FakeWindowLimiter(Number.MAX_SAFE_INTEGER, 86_400_000);
  const { logger, lines } = recordingLogger();

  const policy: PolicyLimiters = { attempts, penalties };
  const limiters = {
    auth_attempt: policy,
    organization_registration: policy,
    api_request: policy,
    heavy_operation: policy,
    client_error_report: policy,
  } satisfies WindowLimiters;

  return { adapter: new RedisRateLimiterAdapter(limiters, logger), attempts, penalties, lines };
};

const exhaust = async (adapter: RedisRateLimiterAdapter): Promise<void> => {
  for (let attempt = 0; attempt < AUTH.points; attempt += 1) {
    await adapter.consume('auth_attempt', SUBJECT);
  }
};

describe('rate limiter — the budget', () => {
  it('allows the attempts the policy grants and reports what is left', async () => {
    const { adapter } = harness();

    const first = await adapter.consume('auth_attempt', SUBJECT);
    expect(first).toEqual({ allowed: true, remaining: AUTH.points - 1 });

    const second = await adapter.consume('auth_attempt', SUBJECT);
    expect(second).toEqual({ allowed: true, remaining: AUTH.points - 2 });
  });

  it('refuses the sixth attempt of the window', async () => {
    const { adapter } = harness();

    await exhaust(adapter);

    expect(await adapter.consume('auth_attempt', SUBJECT)).toMatchObject({ allowed: false });
  });

  it('answers with the time actually left, not with a constant', async () => {
    const { adapter, attempts } = harness();

    await exhaust(adapter);
    const first = await adapter.consume('auth_attempt', SUBJECT);

    attempts.advance(400_000);
    const later = await adapter.consume('auth_attempt', SUBJECT);

    expect(first).toMatchObject({ allowed: false });
    expect(later).toMatchObject({ allowed: false });
    if (first.allowed || later.allowed) throw new Error('unreachable');

    expect(later.retryAfterSeconds).toBeLessThan(first.retryAfterSeconds);
    expect(later.retryAfterSeconds).toBe(first.retryAfterSeconds - 400);
  });

  it('rounds the last fraction of a second up, never down to "retry immediately"', async () => {
    const { adapter, attempts } = harness();

    await exhaust(adapter);
    await adapter.consume('auth_attempt', SUBJECT);

    // One millisecond of block left: still refused, and `Retry-After: 0` would invite the tight
    // retry loop the block exists to stop.
    attempts.advance(AUTH.blockSeconds * 1000 - 1);
    const decision = await adapter.consume('auth_attempt', SUBJECT);

    if (decision.allowed) throw new Error('unreachable');
    expect(decision.retryAfterSeconds).toBe(1);
  });
});

describe('rate limiter — escalation', () => {
  it('blocks longer on every repeat instead of restarting the window', async () => {
    const { adapter, attempts } = harness();

    await exhaust(adapter);
    const first = await adapter.consume('auth_attempt', SUBJECT);

    // The block expires; the pair comes back and burns the budget again.
    attempts.advance(AUTH.blockSeconds * 1000 + 1000);
    await exhaust(adapter);
    const second = await adapter.consume('auth_attempt', SUBJECT);

    if (first.allowed || second.allowed) throw new Error('unreachable');
    expect(first.retryAfterSeconds).toBe(AUTH.blockSeconds);
    expect(second.retryAfterSeconds).toBe(AUTH.blockSeconds * 2);
  });

  it('does not escalate again while the same block is still being hit', async () => {
    const { adapter, penalties } = harness();

    await exhaust(adapter);
    await adapter.consume('auth_attempt', SUBJECT);
    await adapter.consume('auth_attempt', SUBJECT);
    await adapter.consume('auth_attempt', SUBJECT);

    expect(penalties.consumedFor(KEY)).toBe(1);
  });
});

describe('rate limiter — a successful sign-in', () => {
  it('clears the budget of that pair', async () => {
    const { adapter } = harness();

    await exhaust(adapter);
    await adapter.reset('auth_attempt', SUBJECT);

    expect(await adapter.consume('auth_attempt', SUBJECT)).toEqual({
      allowed: true,
      remaining: AUTH.points - 1,
    });
  });

  it('clears the escalation memory too', async () => {
    const { adapter, penalties } = harness();

    await exhaust(adapter);
    await adapter.consume('auth_attempt', SUBJECT);
    await adapter.reset('auth_attempt', SUBJECT);

    expect(penalties.consumedFor(KEY)).toBe(0);
  });

  it('does not fail a sign-in that already succeeded when the store is gone', async () => {
    const { adapter, attempts, penalties, lines } = harness();

    attempts.storeFailure = new Error('connection lost');
    penalties.storeFailure = attempts.storeFailure;

    await expect(adapter.reset('auth_attempt', SUBJECT)).resolves.toBeUndefined();
    expect(lines.some((line) => line.level === 'warn')).toBe(true);
  });
});

/**
 * The property this whole suite exists for. A limiter that starts answering "allowed" when its
 * store is unreachable is absent exactly when it is needed: the cheapest way to switch off the
 * brute-force defence becomes making Redis unreachable.
 */
describe('rate limiter — an unreachable store', () => {
  let subject: Harness;

  beforeEach(() => {
    subject = harness();
    subject.attempts.storeFailure = new Error('READONLY You cannot write against a replica');
  });

  it('refuses the request instead of letting it through', async () => {
    await expect(subject.adapter.consume('auth_attempt', SUBJECT)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
  });

  it('answers 503, so the client learns the difference from a rate limit', async () => {
    await expect(subject.adapter.consume('auth_attempt', SUBJECT)).rejects.toMatchObject({
      code: 'service_unavailable',
      status: 503,
    });
  });

  it('keeps the driver failure as the cause and out of the response', async () => {
    const error = await subject.adapter
      .consume('auth_attempt', SUBJECT)
      .then(() => undefined)
      .catch((raised: unknown) => raised);

    expect((error as ServiceUnavailableError).cause).toBe(subject.attempts.storeFailure);
    expect((error as ServiceUnavailableError).message).not.toContain('READONLY');
  });
});

describe('rate limiter — what reaches the log', () => {
  it('reports a refusal with the masked pair and never with the address', async () => {
    const { adapter, lines } = harness();

    await exhaust(adapter);
    await adapter.consume('auth_attempt', SUBJECT);

    const written = recordedValues(lines);

    expect(lines.some((line) => line.level === 'warn')).toBe(true);
    expect(written).toContain('203.0.113.0/24');
    expect(written.toLowerCase()).not.toContain('ada.lovelace');
    expect(written).not.toContain('203.0.113.42');
  });

  it('reports an unreachable store at error level, still without the address', async () => {
    const { adapter, attempts, lines } = harness();

    attempts.storeFailure = new Error('connection lost');
    await adapter.consume('auth_attempt', SUBJECT).catch(() => undefined);

    const written = recordedValues(lines);

    expect(lines.some((line) => line.level === 'error')).toBe(true);
    expect(written.toLowerCase()).not.toContain('ada.lovelace');
  });

  it('still refuses the attempt when the escalation write fails', async () => {
    const { adapter, penalties, lines } = harness();

    await exhaust(adapter);
    penalties.storeFailure = new Error('connection lost');

    const decision = await adapter.consume('auth_attempt', SUBJECT);

    if (decision.allowed) throw new Error('unreachable');
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(lines.some((line) => line.level === 'warn')).toBe(true);
  });
});
