import { describe, expect, it } from 'vitest';

import { twoFactorFormSchema } from './two-factor.schema.js';

/**
 * The one thing this schema must not do is decide which kind of code was typed.
 *
 * `POST /auth/2fa/verify` takes six digits from an authenticator **or** an unused recovery code in
 * the same `code` field, and the server tells them apart (`VerifySecondFactorRequest`,
 * STORY-013-03 acceptance 7). A six-digit rule here would refuse a recovery code before the request
 * left the browser — on the one screen that exists for the person whose authenticator is gone.
 */
describe('the second-factor form schema', () => {
  it('accepts six digits from an authenticator', () => {
    expect(twoFactorFormSchema.safeParse({ code: '123456' }).success).toBe(true);
  });

  it('accepts a leading zero, which a numeric field would have eaten', () => {
    const result = twoFactorFormSchema.safeParse({ code: '012345' });

    expect(result.success).toBe(true);
    expect(result.data?.code).toBe('012345');
  });

  /**
   * The case a schema narrowed to `\d{6}` would refuse. A recovery code is neither six characters
   * nor digits — this is the assertion that keeps the field open to both shapes.
   */
  it('accepts a recovery code, which is neither six characters nor digits', () => {
    expect(twoFactorFormSchema.safeParse({ code: 'a1b2c-3d4e5-f6g7h' }).success).toBe(true);
  });

  it('refuses an empty code, and says so with a key rather than a sentence', () => {
    const result = twoFactorFormSchema.safeParse({ code: '' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['code'],
      message: 'validation.second_factor.required',
    });
  });
});
