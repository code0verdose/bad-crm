import { describe, expect, it } from 'vitest';

import { ApiError } from '@shared/api';

import { overrideRefusalNotification } from './override-refusal.util.js';

/**
 * Which sentence a refused write shows — and the reason there is a choice to make at all.
 *
 * Two of this endpoint's four refusals are answered `user_forbidden`, because the permission
 * model's fifteen reasons are deliberately not fifteen error codes
 * (`server/src/domain/access/access.errors.ts`). Translated by `code` alone both read «you do not
 * have access to this person», which is false of both: the caller may edit this person. The
 * distinction survives in the `reason` extension member, and this is the caller that knows what the
 * operation was.
 */

const refusal = (reason: string): ApiError =>
  new ApiError({
    code: 'user_forbidden',
    status: 403,
    requestId: 'req-1',
    issues: [],
    reason: reason as never,
  });

describe('the sentence a refused exception shows', () => {
  it('explains an escalation instead of claiming there is no access', () => {
    expect(overrideRefusalNotification('id', refusal('permission_not_granted'))).toEqual({
      id: 'id',
      messageKey: 'permissions.refusal.permissionNotGranted',
    });
  });

  it('explains that somebody else has to lift a deny from you', () => {
    expect(overrideRefusalNotification('id', refusal('self_assignment_forbidden'))).toEqual({
      id: 'id',
      messageKey: 'permissions.refusal.selfAssignmentForbidden',
    });
  });

  it.each([
    ['a deny aimed at the owner', 'owner_immutable', 'errors.code.owner_immutable'],
    ['locking yourself out', 'self_lockout', 'errors.code.self_lockout'],
  ])('leaves %s to its own error code, which already says it', (_case, code, messageKey) => {
    const error = new ApiError({
      code: code as never,
      status: 409,
      requestId: 'req-1',
      issues: [],
      reason: code as never,
    });

    expect(overrideRefusalNotification('id', error)).toEqual({ id: 'id', messageKey });
  });

  it('falls back to the ordinary sentence when the refusal came from elsewhere', () => {
    const error = new ApiError({ code: 'internal_error', status: 500, requestId: 'r', issues: [] });

    expect(overrideRefusalNotification('id', error)).toEqual({
      id: 'id',
      messageKey: 'errors.code.internal_error',
    });
  });

  it('keeps the seconds a rate limit interpolates, which a bare key would drop', () => {
    const error = new ApiError({
      code: 'rate_limited',
      status: 429,
      requestId: 'r',
      issues: [],
      retryAfterSeconds: 30,
    });

    expect(overrideRefusalNotification('id', error)).toEqual({
      id: 'id',
      messageKey: 'errors.code.rate_limited',
      values: { seconds: 30 },
    });
  });

  it('says something for a failure that is not an API error at all', () => {
    expect(overrideRefusalNotification('id', new TypeError('bundle'))).toEqual({
      id: 'id',
      messageKey: 'errors.code.internal_error',
    });
  });
});
