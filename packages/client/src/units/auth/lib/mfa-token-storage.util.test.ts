import { afterEach, describe, expect, it } from 'vitest';

import { clearMfaToken, readMfaToken, setMfaToken } from '@units/auth/lib';

/**
 * The intermediate credential of the sign-in, in the smallest module that can put it somewhere it
 * must not be.
 *
 * `mfaToken` is not a session token — it carries no rights and is refused on every route but
 * `POST /auth/2fa/verify` — but it is half of what a session costs: whoever holds it and one code
 * gets a session. So it lives exactly as long as the step that owns it, in memory, and the two
 * places it must not be are ruled out elsewhere, by gates that cover the whole tree rather than by
 * a case here: `no-restricted-globals` refuses `localStorage` and `sessionStorage` anywhere in this
 * unit — including in this file, which is why the assertion that used to stand here could not be
 * written at all — and `test/architecture/data-layer-conventions.test.ts` re-checks every source
 * that ships. A URL is ruled out by construction: the step has no route of its own, and nothing
 * below hands the value to a navigation.
 *
 * What is left for this file is the lifetime, which is the part a gate cannot see: it is readable
 * while the step runs, replaced rather than accumulated, and gone afterwards.
 */
afterEach(() => {
  clearMfaToken();
});

describe('the in-memory second-factor token', () => {
  it('is readable while the step that owns it is running', () => {
    setMfaToken('mfa-token-1');

    expect(readMfaToken()).toBe('mfa-token-1');
  });

  it('is replaced by a second password attempt rather than accumulated', () => {
    setMfaToken('mfa-token-1');
    setMfaToken('mfa-token-2');

    expect(readMfaToken()).toBe('mfa-token-2');
  });

  /**
   * Reading with no challenge in progress is a bug in the caller, not a state to render: the step
   * is only on screen while the answer that minted a token is the answer being shown. It throws
   * rather than resolving to an empty string, because an empty string would be *sent*.
   */
  it('refuses to be read when no step is in progress', () => {
    expect(() => readMfaToken()).toThrow(/no second factor/i);
  });

  it('is gone once the step is over', () => {
    setMfaToken('mfa-token-1');
    clearMfaToken();

    expect(() => readMfaToken()).toThrow(/no second factor/i);
  });
});
