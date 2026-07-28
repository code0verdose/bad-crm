/**
 * The access token of this tab, in memory and nowhere else.
 *
 * CLAUDE.md invariant 3, in the smallest module that can break it. `localStorage` and
 * `sessionStorage` survive a tab close and are readable by any script that lands on the page, so a
 * token written there outlives the session it belongs to and is one XSS away from being somebody
 * else's. A module variable dies with the tab, which is exactly the lifetime a fifteen-minute access
 * token should have. ESLint bans both storages in this unit and in `shared/api`, and
 * `test/architecture/data-layer-conventions.test.ts` re-checks the whole tree.
 *
 * The refresh token has no representation here at all: it is an httpOnly cookie the browser attaches
 * and this bundle cannot read.
 *
 * A module variable rather than a store: nothing renders from it. The UI renders from the session
 * state (`units/session`); this value exists for one middleware, on one code path.
 */
let accessToken: string | null = null;

export const readAccessToken = (): string | null => accessToken;

export const setAccessToken = (token: string): void => {
  accessToken = token;
};

export const clearAccessToken = (): void => {
  accessToken = null;
};
