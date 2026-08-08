import { describe, expect, it } from 'vitest';

import { RATE_LIMIT_POLICY } from '@/infrastructure/rate-limit/rate-limit-policy.constant.js';
import { escalatedBlockSeconds } from '@/infrastructure/rate-limit/rate-limit-escalation.util.js';

/**
 * The numbers are a copy of the table in `docs/architecture/stack.md` → «Rate limiting». Asserting
 * them looks like asserting a constant against itself, and would be — if the point were the value.
 * The point is the *unit*: a `duration` in milliseconds instead of seconds would make the login
 * limit 5 attempts per 0.9 seconds, and nothing else in the system would notice.
 */
describe('rate limit policies', () => {
  it('matches the login limit of stack.md: 5 attempts per 15 minutes', () => {
    expect(RATE_LIMIT_POLICY.auth_attempt.points).toBe(5);
    expect(RATE_LIMIT_POLICY.auth_attempt.windowSeconds).toBe(15 * 60);
  });

  it('matches the registration limit of stack.md: 3 per hour', () => {
    expect(RATE_LIMIT_POLICY.organization_registration.points).toBe(3);
    expect(RATE_LIMIT_POLICY.organization_registration.windowSeconds).toBe(60 * 60);
  });

  it('matches the ambient API and heavy-operation limits of stack.md', () => {
    expect(RATE_LIMIT_POLICY.api_request).toMatchObject({ points: 300, windowSeconds: 60 });
    expect(RATE_LIMIT_POLICY.heavy_operation).toMatchObject({ points: 10, windowSeconds: 60 });
  });

  it('matches the invitation limit of stack.md: 20 per 10 minutes', () => {
    expect(RATE_LIMIT_POLICY.invitation_create).toMatchObject({
      points: 20,
      windowSeconds: 10 * 60,
    });
  });

  it('matches the acceptance limit of stack.md: 10 per 15 minutes', () => {
    expect(RATE_LIMIT_POLICY.invitation_accept).toMatchObject({
      points: 10,
      windowSeconds: 15 * 60,
    });
  });

  it('escalates the authentication limit and nothing else', () => {
    expect(RATE_LIMIT_POLICY.auth_attempt.escalation).toBeDefined();
    expect(RATE_LIMIT_POLICY.organization_registration.escalation).toBeUndefined();
    expect(RATE_LIMIT_POLICY.api_request.escalation).toBeUndefined();
    expect(RATE_LIMIT_POLICY.heavy_operation.escalation).toBeUndefined();
    expect(RATE_LIMIT_POLICY.invitation_create.escalation).toBeUndefined();
    expect(RATE_LIMIT_POLICY.invitation_accept.escalation).toBeUndefined();
  });
});

describe('escalated block', () => {
  const escalation = { factor: 2, maxBlockSeconds: 3600, memorySeconds: 86_400 };

  it('doubles with every repeat instead of restarting at the base', () => {
    expect(escalatedBlockSeconds(900, escalation, 1)).toBe(900);
    expect(escalatedBlockSeconds(900, escalation, 2)).toBe(1800);
    expect(escalatedBlockSeconds(900, escalation, 3)).toBe(3600);
  });

  it('stops at the cap, so a locked-out account is not locked out for a week', () => {
    expect(escalatedBlockSeconds(900, escalation, 4)).toBe(3600);
    expect(escalatedBlockSeconds(900, escalation, 40)).toBe(3600);
  });

  it('treats a first-ever breach as the base block', () => {
    expect(escalatedBlockSeconds(900, escalation, 0)).toBe(900);
  });
});
