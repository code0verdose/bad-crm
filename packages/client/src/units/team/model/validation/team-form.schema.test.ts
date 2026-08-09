import { describe, expect, it } from 'vitest';

import { MAX_DESCRIPTION, MAX_NAME, MAX_SLUG, teamFormSchema } from './team-form.schema.js';

/**
 * The bounds this schema exists to enforce, asserted at the boundary rather than assumed from the
 * reading: 100 % line/branch coverage of this file was reachable without ever typing a value long
 * enough to cross `MAX_NAME`/`MAX_SLUG`/`MAX_DESCRIPTION` — every existing case used short fixtures,
 * so a `.max()` widened or dropped altogether left the whole suite green. The server's own bound is
 * closed already (`test/integration/http/team-endpoints.test.ts:134`); this is the client half of
 * the same contract, so a value neither side would refuse cannot exist.
 */

const VALID = { name: 'Backend', slug: 'backend', description: '' };

describe('the name field', () => {
  it('accepts a name at exactly the limit', () => {
    const result = teamFormSchema.safeParse({ ...VALID, name: 'a'.repeat(MAX_NAME) });

    expect(result.success).toBe(true);
  });

  it('refuses a name one character past the limit', () => {
    const result = teamFormSchema.safeParse({ ...VALID, name: 'a'.repeat(MAX_NAME + 1) });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['name'],
      message: 'teams.field.nameTooLong',
    });
  });

  it('refuses an empty name', () => {
    const result = teamFormSchema.safeParse({ ...VALID, name: '' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['name'],
      message: 'validation.required',
    });
  });
});

describe('the slug field', () => {
  it('accepts a slug at exactly the limit', () => {
    // The pattern allows only `[a-z0-9]` and single hyphens between groups, so the fixture at the
    // boundary has to be a value the regex would also accept — not merely 64 characters of anything.
    const slug = `${'a'.repeat(31)}-${'b'.repeat(32)}`;
    expect(slug).toHaveLength(MAX_SLUG);

    const result = teamFormSchema.safeParse({ ...VALID, slug });

    expect(result.success).toBe(true);
  });

  it('refuses a slug one character past the limit', () => {
    const slug = `${'a'.repeat(32)}-${'b'.repeat(32)}`;
    expect(slug).toHaveLength(MAX_SLUG + 1);

    const result = teamFormSchema.safeParse({ ...VALID, slug });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message === 'teams.field.slugTooLong')).toBe(
      true,
    );
  });

  /**
   * STORY-012-07's client half of criterion 5: the server already refuses an empty slug
   * (`team-endpoints.test.ts:131`) with a `422`, and until this case the form had nothing stopping
   * the request from being sent — `.min(1)` existed in the source but nothing would have noticed it
   * being removed, unlike `name`'s identical rule (`team-list.test.tsx:305`).
   */
  it('refuses an empty slug, the same way it refuses an empty name', () => {
    const result = teamFormSchema.safeParse({ ...VALID, slug: '' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['slug'],
      message: 'validation.required',
    });
  });

  it('refuses a slug the pattern does not allow', () => {
    const result = teamFormSchema.safeParse({ ...VALID, slug: 'Backend Team' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message === 'teams.field.slugInvalid')).toBe(
      true,
    );
  });
});

describe('the description field', () => {
  it('accepts a description at exactly the limit', () => {
    const result = teamFormSchema.safeParse({ ...VALID, description: 'a'.repeat(MAX_DESCRIPTION) });

    expect(result.success).toBe(true);
  });

  it('refuses a description one character past the limit', () => {
    const result = teamFormSchema.safeParse({
      ...VALID,
      description: 'a'.repeat(MAX_DESCRIPTION + 1),
    });

    expect(result.success).toBe(false);
    expect(
      result.error?.issues.some((issue) => issue.message === 'teams.field.descriptionTooLong'),
    ).toBe(true);
  });

  it('accepts an empty description — it is optional prose, not a required field', () => {
    expect(teamFormSchema.safeParse({ ...VALID, description: '' }).success).toBe(true);
  });
});
