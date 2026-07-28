import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  ERROR_CODE_STATUS,
  ERROR_RESOURCES,
  PROBLEM_TYPE_BASE_URL,
  errorCodeStatus,
  isErrorCode,
  problemTypeUrl,
} from '../../src/errors/index.js';
import type { ErrorCode } from '../../src/errors/index.js';

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

describe('error code catalog', () => {
  it('is a non-empty, duplicate-free list', () => {
    expect(ERROR_CODES.length).toBeGreaterThan(0);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('uses stable machine-readable snake_case codes the client maps to i18n keys', () => {
    expect(ERROR_CODES.filter((code) => !SNAKE_CASE.test(code))).toEqual([]);
  });

  it.each([
    ['validation_failed', 422],
    ['unauthenticated', 401],
    ['rate_limited', 429],
    ['stale_version', 409],
    ['internal_error', 500],
    ['feature_disabled', 501],
    ['idempotency_key_reuse', 409],
    // Transport-level refusals, added by STORY-003-01: the body limit and the unmatched route are
    // answered before any resource is known, so neither can borrow a `<resource>_…` code.
    ['payload_too_large', 413],
    ['route_not_found', 404],
    // Authentication, added by EPIC-006. `invalid_credentials` is one code for two situations on
    // purpose — see the dedicated assertion below.
    ['invalid_credentials', 401],
    ['account_suspended', 403],
    ['registration_disabled', 403],
    ['password_reset_token_invalid', 400],
    ['mail_not_configured', 503],
  ] as const)('maps %s to HTTP %i (stack.md, «Формат ошибок»)', (code, status) => {
    expect(errorCodeStatus(code)).toBe(status);
  });

  /**
   * The epic-level acceptance criterion of EPIC-006: "the answer to «no such user» and to «wrong
   * password» is indistinguishable by code, by text and by response time".
   *
   * A catalog cannot enforce the timing half, and it cannot enforce that a use-case picks the right
   * code. What it can enforce is that no *second* code exists for the losing half of that pair: as
   * long as `user_not_found` is the only other candidate and it is a 404 belonging to the resource
   * family, an author who wants to distinguish the two cases has to add a code to this file, in a
   * reviewed diff, next to this comment.
   */
  it('offers exactly one code for a refused credential', () => {
    const refusals = ERROR_CODES.filter(
      (code) => ERROR_CODE_STATUS[code] === 401 && code !== 'unauthenticated',
    );

    expect(refusals).toEqual(['invalid_credentials']);
  });

  /**
   * `session` joins the resource list so that revoking a session that belongs to somebody else is
   * `session_not_found` (404) rather than a bare 403 — invariant 2 of CLAUDE.md applied to a
   * resource whose ids are guessable and whose existence is worth hiding.
   */
  it('knows the session resource, so a foreign session is 404 and not 403', () => {
    expect(ERROR_RESOURCES).toContain('session');
    expect(errorCodeStatus('session_not_found')).toBe(404);
  });

  it('assigns a 4xx or 5xx status to every declared code', () => {
    expect(ERROR_CODES.filter((code) => ERROR_CODE_STATUS[code] < 400)).toEqual([]);
  });

  it('derives per-resource codes so a typo cannot invent a new one', () => {
    expect(ERROR_CODES).toContain('task_not_found');
    expect(ERROR_CODES).toContain('task_forbidden');
    expect(ERROR_CODES).toContain('task_already_exists');
  });

  it.each([
    ['not_found', 404],
    ['forbidden', 403],
    ['already_exists', 409],
  ] as const)('maps every <resource>_%s to HTTP %i', (suffix, status) => {
    const wrong = ERROR_RESOURCES.map((resource): ErrorCode => `${resource}_${suffix}`).filter(
      (code) => ERROR_CODE_STATUS[code] !== status,
    );

    expect(wrong).toEqual([]);
  });

  it('narrows an unknown string to a code only when the catalog contains it', () => {
    expect(isErrorCode('validation_failed')).toBe(true);
    expect(isErrorCode('validation_faild')).toBe(false);
    expect(isErrorCode('')).toBe(false);
  });

  it('builds the problem+json `type` URL from the code (RFC 9457)', () => {
    expect(problemTypeUrl('validation_failed')).toBe(`${PROBLEM_TYPE_BASE_URL}/validation-failed`);
    expect(problemTypeUrl('task_not_found')).toBe(`${PROBLEM_TYPE_BASE_URL}/task-not-found`);
  });
});
