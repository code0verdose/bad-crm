import { type SharedErrors, type SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@shared/api';

import { projectFormFailure } from './project-form-failure.util.js';
import { projectRefusalMessage, projectRefusalNotification } from './project-refusal.util.js';

const apiError = (
  code: SharedErrors.ErrorCode,
  status: number,
  extra: {
    issues?: SharedErrors.ValidationIssue[];
    reason?: SharedPermissions.DenyReason;
    retryAfterSeconds?: number;
  } = {},
): ApiError =>
  new ApiError({
    code,
    status,
    requestId: 'r',
    issues: extra.issues ?? [],
    ...(extra.reason === undefined ? {} : { reason: extra.reason }),
    ...(extra.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: extra.retryAfterSeconds }),
  });

describe('projectFormFailure', () => {
  it('is nothing while nothing has been refused', () => {
    expect(projectFormFailure(null)).toEqual({ fields: {}, notice: undefined });
  });

  it('puts a taken key under the key', () => {
    expect(projectFormFailure(apiError('project_already_exists', 409))).toEqual({
      fields: { key: { key: 'projects.field.keyTaken' } },
      notice: undefined,
    });
  });

  it.each([
    ['user_not_found', 404, 'projects.field.leadUnavailable'],
    ['member_not_active', 409, 'projects.field.leadInactive'],
  ] as const)('puts %s under the lead', (code, status, key) => {
    expect(projectFormFailure(apiError(code, status)).fields).toEqual({ leadId: { key } });
  });

  it('puts handing the lead to oneself under the lead, not above the form', () => {
    const failure = projectFormFailure(
      apiError('user_forbidden', 403, { reason: 'self_assignment_forbidden' }),
    );

    expect(failure).toEqual({
      fields: { leadId: { key: 'projects.field.leadSelf' } },
      notice: undefined,
    });
  });

  it('puts each 422 issue under its own field, the date rule in the form’s own words', () => {
    const failure = projectFormFailure(
      apiError('validation_failed', 422, {
        issues: [
          { path: 'name', code: 'too_big', message: 'x' },
          { path: 'dueAt', code: 'custom', message: 'x' },
          { path: 'name', code: 'too_small', message: 'x' },
        ],
      }),
    );

    expect(failure.fields).toEqual({
      name: { key: 'errors.field.too_big' },
      dueAt: { key: 'projects.field.dueBeforeStart' },
    });
    expect(failure.notice).toBeUndefined();
  });

  it('sends a 422 that names no field of the form above the form, so it is never silent', () => {
    const failure = projectFormFailure(
      apiError('validation_failed', 422, {
        issues: [{ path: 'status', code: 'unrecognized_keys', message: 'x' }],
      }),
    );

    expect(failure).toEqual({ fields: {}, notice: { key: 'errors.code.validation_failed' } });
  });

  it('sends a rate limit above the form with its seconds', () => {
    expect(projectFormFailure(apiError('rate_limited', 429, { retryAfterSeconds: 30 }))).toEqual({
      fields: {},
      notice: { key: 'errors.code.rate_limited', values: { seconds: 30 } },
    });
  });

  it('sends something that is not an API error above the form as the generic sentence', () => {
    expect(projectFormFailure(new Error('boom')).notice).toEqual({
      key: 'errors.code.internal_error',
    });
  });
});

describe('projectRefusalMessage', () => {
  it.each([
    ['permission_not_granted', 'projects.refusal.permissionNotGranted'],
    ['insufficient_acl_level', 'projects.refusal.insufficientLevel'],
    ['self_assignment_forbidden', 'projects.refusal.selfAssignment'],
  ] as const)('explains %s by its reason, not by the collapsed code', (reason, key) => {
    expect(projectRefusalMessage(apiError('user_forbidden', 403, { reason }))).toEqual({ key });
  });

  it('falls back to the sentence of the code for everything else', () => {
    expect(projectRefusalMessage(apiError('last_project_lead_required', 409))).toEqual({
      key: 'errors.code.last_project_lead_required',
    });
    expect(
      projectRefusalMessage(apiError('user_forbidden', 403, { reason: 'vault_locked' })),
    ).toEqual({ key: 'errors.code.user_forbidden' });
  });
});

describe('projectRefusalNotification', () => {
  it('is the refusal sentence under the caller’s id, with no values when the sentence has none', () => {
    expect(
      projectRefusalNotification(
        'roster',
        apiError('user_forbidden', 403, { reason: 'self_assignment_forbidden' }),
      ),
    ).toEqual({ id: 'roster', messageKey: 'projects.refusal.selfAssignment' });
  });

  it('carries the seconds of a rate limit', () => {
    expect(
      projectRefusalNotification('roster', apiError('rate_limited', 429, { retryAfterSeconds: 7 })),
    ).toEqual({ id: 'roster', messageKey: 'errors.code.rate_limited', values: { seconds: 7 } });
  });
});
