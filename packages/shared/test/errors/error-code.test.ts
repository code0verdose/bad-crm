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
  ] as const)('maps %s to HTTP %i (stack.md, «Формат ошибок»)', (code, status) => {
    expect(errorCodeStatus(code)).toBe(status);
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
