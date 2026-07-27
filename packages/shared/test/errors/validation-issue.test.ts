import { describe, expect, it } from 'vitest';

import {
  VALIDATION_ISSUE_CODES,
  asValidationIssueCode,
  isValidationIssueCode,
  type ValidationIssue,
} from '../../src/errors/validation-issue.enums.js';

describe('catalog of per-field validation codes', () => {
  it('is a closed, non-empty list', () => {
    expect(VALIDATION_ISSUE_CODES.length).toBeGreaterThan(0);
    expect(new Set(VALIDATION_ISSUE_CODES).size).toBe(VALIDATION_ISSUE_CODES.length);
  });

  /**
   * The list is the set of `code` values Zod 4 can put on an issue. It is restated here rather
   * than imported because it is a wire contract: the client maps every one of these to an i18n
   * key, and a Zod release that renames one must break this test instead of silently shipping an
   * untranslatable code to the browser. `packages/shared` is also isomorphic and must not depend
   * on the server's validator.
   */
  it.each([
    'invalid_type',
    'too_big',
    'too_small',
    'invalid_format',
    'not_multiple_of',
    'unrecognized_keys',
    'invalid_union',
    'invalid_key',
    'invalid_element',
    'invalid_value',
    'custom',
  ])('contains %s', (code) => {
    expect(VALIDATION_ISSUE_CODES).toContain(code);
  });

  it.each(VALIDATION_ISSUE_CODES)('recognises %s', (code) => {
    expect(isValidationIssueCode(code)).toBe(true);
  });

  it.each(['', 'invalid_typo', 'INVALID_TYPE', 'validation_failed'])(
    'rejects %s, so a free string cannot reach the client as a code',
    (code) => {
      expect(isValidationIssueCode(code)).toBe(false);
    },
  );
});

/**
 * Zod may grow a code this project has never seen — a new issue kind in a minor release, or a
 * `.refine` in a third-party schema. Falling back to `custom` keeps `errors[].code` inside the
 * enum the OpenAPI document declares; passing the unknown string through would produce a response
 * that fails its own contract test and a client with no message to show.
 */
describe('narrowing an arbitrary string to the catalog', () => {
  it('keeps a known code', () => {
    expect(asValidationIssueCode('too_small')).toBe('too_small');
  });

  it.each(['', 'brand_new_zod_code', 'invalid_typo'])('maps %s to custom', (code) => {
    expect(asValidationIssueCode(code)).toBe('custom');
  });
});

describe('the shape carried in errors[]', () => {
  it('names the field, the code and a developer message', () => {
    const issue: ValidationIssue = {
      path: 'amount.value',
      code: 'invalid_type',
      message: 'Invalid input: expected number, received string',
    };

    expect(Object.keys(issue).sort()).toEqual(['code', 'message', 'path']);
  });
});
