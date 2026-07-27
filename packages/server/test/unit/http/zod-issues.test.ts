import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { toValidationIssues } from '@/presentation/http/validators/zod-issues.util.js';

/** Fails a schema on purpose and hands over the resulting `ZodError`. */
const errorOf = (schema: z.ZodType, value: unknown): z.ZodError => {
  const result = schema.safeParse(value);

  expect(result.success, 'the fixture is supposed to be invalid').toBe(false);

  return (result as { error: z.ZodError }).error;
};

describe('a Zod failure becomes a per-field list', () => {
  it('reports one entry per offending field, not one per request', () => {
    const schema = z.object({ title: z.string().min(1), age: z.number() });

    const issues = toValidationIssues(errorOf(schema, { title: '', age: 'old' }));

    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.path).sort()).toEqual(['age', 'title']);
  });

  /**
   * The acceptance case of STORY-003-04: the client is told which input to highlight. A count —
   * which is what this endpoint used to answer with — tells a form nothing it can act on.
   */
  it('addresses a nested field in dot notation', () => {
    const schema = z.object({ amount: z.object({ value: z.number() }) });

    const [issue] = toValidationIssues(errorOf(schema, { amount: { value: '10' } }));

    expect(issue?.path).toBe('amount.value');
    expect(issue?.code).toBe('invalid_type');
  });

  it('addresses an element of an array by index, not by the position of the Zod issue', () => {
    const schema = z.object({ items: z.array(z.object({ title: z.string().min(1) })) });

    const issues = toValidationIssues(
      errorOf(schema, { items: [{ title: 'ok' }, { title: '' }, { title: '' }] }),
    );

    expect(issues.map((issue) => issue.path)).toEqual(['items[1].title', 'items[2].title']);
  });

  it('describes a failure of the value as a whole with an empty path', () => {
    const issues = toValidationIssues(errorOf(z.object({ a: z.string() }), 'not an object'));

    expect(issues.map((issue) => issue.path)).toEqual(['']);
  });

  it('carries a developer message, so a failing test says what was expected', () => {
    const [issue] = toValidationIssues(errorOf(z.object({ age: z.number() }), { age: 'old' }));

    expect(issue?.message).toMatch(/number/i);
  });

  /**
   * A `.refine` produces `custom`, which is in the catalog. The narrowing exists for the codes
   * that are not — a future Zod issue kind — and the property that matters is that nothing outside
   * the published enum can reach `errors[].code`.
   */
  it('keeps every code inside the catalog the OpenAPI enum publishes', () => {
    const schema = z.object({
      from: z.number(),
      to: z.number(),
      email: z.email(),
      tag: z.enum(['a', 'b']),
      size: z.number().multipleOf(5),
    });
    const issues = toValidationIssues(
      errorOf(schema, { from: 1, to: 0, email: 'nope', tag: 'c', size: 3 }),
    );

    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(VALID_CODES, issue.path).toContain(issue.code);
    }
  });

  it('reports an unknown key against that key, so the caller knows which one to drop', () => {
    const schema = z.strictObject({ page: z.number() });

    const issues = toValidationIssues(errorOf(schema, { page: 1, perPage: 10 }));

    expect(issues.map((issue) => issue.code)).toEqual(['unrecognized_keys']);
    expect(issues.map((issue) => issue.path)).toEqual(['perPage']);
  });
});

const VALID_CODES = [
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
];
