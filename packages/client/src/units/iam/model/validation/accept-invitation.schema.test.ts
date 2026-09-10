import { describe, expect, it } from 'vitest';

import { acceptInvitationFormSchema } from './accept-invitation.schema.js';

/**
 * The invitation form applies the whole password policy, not the bounds alone.
 *
 * Until 2026-09-10 this was the one form of the four that set a password with `passwordSchema` —
 * twelve characters and nothing else — so `qwertyuiop12` passed here, crossed the wire, and came
 * back as a `422` the form had no field error for. The other three forms refuse the shape before
 * the round trip through `newPasswordSchema`; this one now does the same, and what is asserted is
 * the **path** as well as the key: an error attached to the object instead of the field has nothing
 * for `aria-describedby` to point at (`rules/a11y.mdc` §18).
 */

const parse = (password: string, confirmPassword = password) =>
  acceptInvitationFormSchema.safeParse({ password, confirmPassword, locale: 'en' });

const issueAt = (result: ReturnType<typeof parse>, field: string): string | undefined =>
  result.success
    ? undefined
    : result.error.issues.find((issue) => issue.path.join('.') === field)?.message;

describe('the password of an invited person', () => {
  it('refuses a known weak shape under the password field, before the round trip', () => {
    const result = parse('qwertyuiop12'); // scan-secrets:allow gitleaks:allow

    expect(issueAt(result, 'password')).toBe('validation.password.weak');
    expect(issueAt(result, 'confirmPassword')).toBeUndefined();
  });

  it('CONTROL: accepts a password the server would accept', () => {
    expect(parse('correct-horse-battery').success).toBe(true);
  });

  it('still reports the two fields differing under the confirmation', () => {
    const result = parse('correct-horse-battery', 'correct-horse-batter');

    expect(issueAt(result, 'confirmPassword')).toBe('validation.password.mismatch');
  });
});
