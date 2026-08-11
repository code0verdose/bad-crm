import { describe, expect, it } from 'vitest';

import {
  EXPIRY_IN_PAST_KEY,
  EXPIRY_REQUIRED_KEY,
  REASON_TOO_SHORT_KEY,
  permissionOverrideFormSchema,
} from './permission-override.schema.js';

/**
 * The two things that have to be true before one person differs from their role.
 *
 * Both are the contract's rules restated where the person is typing, so the answer arrives before
 * the 422 rather than after it. What is asserted is the **path** as well as the message: an error
 * attached to the object instead of the field has nothing for `aria-describedby` to point at, and
 * `@mantine/form` renders it nowhere at all (`rules/a11y.mdc` §18).
 */

const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);

const parse = (values: Record<string, unknown>) => permissionOverrideFormSchema.safeParse(values);

const issueAt = (result: ReturnType<typeof parse>, field: string): string | undefined =>
  result.success
    ? undefined
    : result.error.issues.find((issue) => issue.path.join('.') === field)?.message;

describe('what an exception has to carry', () => {
  it('accepts a reason and a date', () => {
    const result = parse({
      reason: 'covering billing while Pyotr is on leave',
      neverExpires: false,
      expiresOn: TOMORROW,
    });

    expect(result.success).toBe(true);
  });

  it('refuses a reason nobody could read in six months', () => {
    const result = parse({ reason: 'because', neverExpires: false, expiresOn: TOMORROW });

    expect(issueAt(result, 'reason')).toBe(REASON_TOO_SHORT_KEY);
  });

  it('counts the reason after trimming, so nine characters and a space are still nine', () => {
    const result = parse({
      reason: '   covering  ',
      neverExpires: false,
      expiresOn: TOMORROW,
    });

    expect(issueAt(result, 'reason')).toBe(REASON_TOO_SHORT_KEY);
  });

  it('refuses an exception with no end and no decision about it', () => {
    const result = parse({
      reason: 'covering billing while Pyotr is on leave',
      neverExpires: false,
      expiresOn: '',
    });

    expect(issueAt(result, 'expiresOn')).toBe(EXPIRY_REQUIRED_KEY);
  });

  it('accepts «until somebody removes it» as that decision, and only then', () => {
    const result = parse({
      reason: 'covering billing while Pyotr is on leave',
      neverExpires: true,
      expiresOn: '',
    });

    expect(result.success).toBe(true);
  });

  it.each([
    ['yesterday', YESTERDAY],
    // Today is refused too: the instant written is the **start** of the chosen day, so «today»
    // is an exception that expired before it was saved.
    ['today', TODAY],
  ])('refuses %s — an expired exception grants nothing', (_case, expiresOn) => {
    const result = parse({
      reason: 'covering billing while Pyotr is on leave',
      neverExpires: false,
      expiresOn,
    });

    expect(issueAt(result, 'expiresOn')).toBe(EXPIRY_IN_PAST_KEY);
  });

  it('leaves the date alone once «until somebody removes it» is ticked', () => {
    // A stale value in a disabled field must not be able to refuse the form: the checkbox is the
    // answer, and the date is no longer part of the question.
    const result = parse({
      reason: 'covering billing while Pyotr is on leave',
      neverExpires: true,
      expiresOn: YESTERDAY,
    });

    expect(result.success).toBe(true);
  });

  it('refuses something that is not a date at all', () => {
    const result = parse({
      reason: 'covering billing while Pyotr is on leave',
      neverExpires: false,
      expiresOn: 'soon',
    });

    expect(issueAt(result, 'expiresOn')).toBe(EXPIRY_REQUIRED_KEY);
  });
});
