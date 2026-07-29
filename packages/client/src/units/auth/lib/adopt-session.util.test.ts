import { afterEach, describe, expect, it } from 'vitest';

import { type SharedApi } from '@shared';

import { adoptSession, clearAccessToken, readAccessToken } from '@units/auth/lib';

/**
 * The one place an answer from `/auth/login` or `/auth/refresh` is taken apart — and therefore the
 * one place the access token can end up somewhere it must not be (CLAUDE.md, invariant 3).
 *
 * What is asserted is the split itself: the token goes to memory and is not part of what the
 * function returns, and the identity is *parsed* rather than trusted — a body whose ids are not
 * UUIDs is an answer this client cannot read, and reading it anyway would put a branded `UserId`
 * that is not one into a query key.
 */
const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

type RefreshedSession = SharedApi.RefreshedSession;

const session = (overrides: Partial<RefreshedSession> = {}): RefreshedSession => ({
  status: 'authenticated',
  accessToken: 'access-token-1',
  tokenType: 'Bearer',
  expiresIn: 900,
  user: { id: USER_ID, email: 'ada@example.com', locale: 'en', timezone: 'Europe/Berlin' },
  organization: { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
  ...overrides,
});

afterEach(() => {
  clearAccessToken();
});

describe('adopting a session from the wire', () => {
  it('returns who the tab is signed in as', () => {
    expect(adoptSession(session())).toEqual({
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
    });
  });

  it('puts the access token in memory and nowhere in its answer', () => {
    const identity = adoptSession(session());

    expect(readAccessToken()).toBe('access-token-1');
    expect(JSON.stringify(identity)).not.toContain('access-token-1');
  });

  it('reports no session and forgets the previous token when the exchange came back empty', () => {
    adoptSession(session());

    expect(adoptSession(null)).toBeNull();
    expect(readAccessToken()).toBeNull();
  });

  /**
   * A body that does not match the contract is not a session. Keeping the old token would leave the
   * tab authenticated on the strength of an answer it could not read.
   */
  it.each([
    ['the user id is not a uuid', session({ user: { ...session().user, id: 'not-a-uuid' } })],
    [
      'the organization id is not a uuid',
      session({ organization: { ...session().organization, id: '42' } }),
    ],
  ])('reports no session when %s', (_case, malformed) => {
    adoptSession(session());

    expect(adoptSession(malformed)).toBeNull();
    expect(readAccessToken()).toBeNull();
  });
});
