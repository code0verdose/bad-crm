import { describe, expect, it } from 'vitest';

import { readRepoFile } from './repo-fixture.util.js';

/**
 * The one raw `fetch` in the client, and the thing that will remove it.
 *
 * `rules/api-contract.mdc` forbids reaching the network outside the generated client. Token refresh
 * breaks that rule today for a reason that is temporary and not a matter of taste: `POST
 * /auth/refresh` is not in `docs/api/openapi.yaml`, because the server does not implement it yet
 * (EPIC-006) and the contract test refuses an operation with no route behind it. `openapi-fetch`
 * cannot address a path the contract does not declare, so the call is written by hand.
 *
 * An exception with a good reason and no expiry is a rule nobody enforces. This test is the expiry:
 * the moment the contract publishes the operation, it fails and says what to do. Without it the raw
 * `fetch` outlives its reason and becomes the precedent for the next one.
 */

const REFRESH_SOURCE = 'packages/client/src/shared/api/session-refresh.api.ts';

describe('the hand-written refresh call is bounded by the contract', () => {
  it('still exists where the exception says it does', () => {
    expect(readRepoFile(REFRESH_SOURCE)).toMatch(/\bfetch\b/);
  });

  /**
   * The removal trigger. Once `/auth/refresh` appears under `paths`, the typed client can address
   * it and the exception has nothing left to stand on.
   */
  it('stops being justified once the contract declares the refresh operation', () => {
    const declaresRefresh = /^\s{2}\/auth\/refresh:/m.test(readRepoFile('docs/api/openapi.yaml'));

    expect(
      declaresRefresh,
      'docs/api/openapi.yaml now declares /auth/refresh — replace the raw fetch in ' +
        `${REFRESH_SOURCE} with a call through \`apiClient\`, then delete this test ` +
        '(rules/api-contract.mdc)',
    ).toBe(false);
  });

  it('says in the source why it is allowed and when it goes', () => {
    const source = readRepoFile(REFRESH_SOURCE);

    expect(source).toMatch(/EPIC-006/);
    expect(source).toMatch(/contract|openapi/i);
  });
});
