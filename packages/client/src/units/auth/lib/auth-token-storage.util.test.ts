import { afterEach, describe, expect, it } from 'vitest';

import { clearAccessToken, readAccessToken, setAccessToken } from '@units/auth/lib';

/**
 * Invariant 3 of CLAUDE.md, in the smallest module that can break it: the access token lives in
 * memory and nowhere else. Web Storage survives a tab close and is readable by any script that
 * lands on the page, so a token written there outlives the session it belongs to and is one XSS
 * away from being someone else's. The refresh half of the pair is an httpOnly cookie the client
 * cannot read at all, which is why nothing here stores it.
 */
afterEach(() => {
  clearAccessToken();
});

describe('the in-memory access token', () => {
  it('starts empty, so a fresh tab is anonymous until it proves otherwise', () => {
    expect(readAccessToken()).toBeNull();
  });

  it('is readable after a sign-in has stored it', () => {
    setAccessToken('token-1');

    expect(readAccessToken()).toBe('token-1');
  });

  it('is replaced by a rotation rather than accumulated', () => {
    setAccessToken('token-1');
    setAccessToken('token-2');

    expect(readAccessToken()).toBe('token-2');
  });

  it('is gone after a sign-out', () => {
    setAccessToken('token-1');
    clearAccessToken();

    expect(readAccessToken()).toBeNull();
  });
});
