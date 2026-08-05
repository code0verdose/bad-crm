import { DENY_REASONS } from '@bad-crm/shared/permissions';
import { ERROR_CODES, VALIDATION_ISSUE_CODES } from '@bad-crm/shared/errors';
import { describe, expect, it } from 'vitest';

import { readOpenApiDocument, schemaEnum } from './openapi-document.util.js';

/**
 * The catalog in `packages/shared` and the `enum` in the specification are the same list, or the
 * build fails.
 *
 * They cannot be generated from one another — the specification is written by hand on purpose
 * (ADR-0003) — so the only thing keeping them together is this comparison. Without it the two
 * drift in the cheapest possible way: a code is added to the server, the client's dictionary never
 * learns about it, and the user sees a raw identifier or an empty error.
 */
describe('the error catalog and the published enum are the same list', () => {
  it.each([
    ['ErrorCode', () => [...ERROR_CODES]],
    ['ValidationIssueCode', () => [...VALIDATION_ISSUE_CODES]],
    // The refusal reasons are published too, as an extension member of the problem document, and
    // they drift the same way: a reason added in the domain that the specification never learns
    // about is a value a client meets and cannot explain.
    ['DenyReason', () => [...DENY_REASONS]],
  ])('%s matches packages/shared exactly', (schema, catalog) => {
    const published = schemaEnum(readOpenApiDocument(), schema);

    expect([...published].sort()).toEqual([...catalog()].sort());
  });

  it.each(['ErrorCode', 'ValidationIssueCode', 'DenyReason'])(
    'publishes %s without duplicates',
    (schema) => {
      const published = schemaEnum(readOpenApiDocument(), schema);

      expect(new Set(published).size).toBe(published.length);
    },
  );

  it('has a non-trivial catalog, so the comparison is not two empty lists', () => {
    expect(ERROR_CODES.length).toBeGreaterThan(10);
    expect(VALIDATION_ISSUE_CODES.length).toBeGreaterThan(5);
    expect(DENY_REASONS.length).toBeGreaterThan(10);
  });

  /**
   * `Problem` is the shape every failure of this API takes, so the fields a client is allowed to
   * rely on are asserted here rather than left to a reviewer noticing a deletion. `instance` is
   * asserted absent for the reason recorded in `problem.serializer.ts`.
   */
  it('describes the problem document the server actually sends', () => {
    const problem = readOpenApiDocument().components?.schemas?.['Problem'] as
      { required?: string[]; properties?: Record<string, unknown> } | undefined;

    expect(problem?.required?.sort()).toEqual(['code', 'requestId', 'status', 'title', 'type']);
    expect(Object.keys(problem?.properties ?? {})).toContain('errors');
    expect(Object.keys(problem?.properties ?? {})).toContain('reason');
    expect(problem?.properties).not.toHaveProperty('instance');
  });
});
