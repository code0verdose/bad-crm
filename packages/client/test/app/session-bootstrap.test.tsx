import i18next from 'i18next';
import { render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCimodeLanguage } from '../support/test-language.util.js';

/**
 * The application from the first frame: what is on screen before the client knows who it is, and
 * where it lands once it does.
 *
 * This is the acceptance of STORY-006-05 read literally. A reload with a live refresh cookie has to
 * end on the page the user was on, with no frame of the login form in between; a reload without one
 * has to end on `/login`, silently, because «you are not signed in» is the normal state of a
 * visitor rather than a failure to report.
 *
 * Every case re-imports `@app` after `vi.resetModules()`: the session store, the router and the API
 * client are module singletons by design — one session, one route tree, one cache per tab — and a
 * case that signed in would otherwise hand the next one a session it never created. Vitest does not
 * reset externalised dependencies, so React remains the single instance the testing library holds.
 */
const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const ACCESS_TOKEN = 'access-token-1';

const authenticated = (): Response =>
  new Response(
    JSON.stringify({
      status: 'authenticated',
      accessToken: ACCESS_TOKEN,
      tokenType: 'Bearer',
      expiresIn: 900,
      user: { id: USER_ID, email: 'ada@example.com', locale: 'en', timezone: 'Europe/Berlin' },
      organization: { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const refused = (): Response => new Response(null, { status: 401 });

/** A refresh that never answers, so the gap between the first paint and the session is observable. */
const neverAnswers = (): Promise<Response> => new Promise<Response>(() => undefined);

/**
 * Restored rather than unstubbed. `vi.unstubAllGlobals()` would also remove `matchMedia`,
 * `scrollTo` and `ResizeObserver` — the three platform APIs `test/setup` supplies because jsdom
 * does not, and without which every Mantine tree throws on mount.
 */
const platformFetch = globalThis.fetch;

const startAt = (path: string) => {
  window.history.pushState({}, '', path);
};

/**
 * Queries are scoped to the tree this case mounted, not to `document.body`.
 *
 * Each case mounts a whole application, and `role="status"` is worn by two of its parts — the
 * loading screen and the route announcer. A document-wide query is then a query over whatever the
 * previous case left behind as well, and it fails as «found multiple» in a way that reads like a
 * defect in the component.
 */
const renderApplication = async () => {
  vi.resetModules();
  const { App } = await import('@app');

  return within(render(<App i18n={i18next} />).container);
};

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  setCimodeLanguage();
  startAt('/dashboard');
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('while the session is still unknown', () => {
  it('shows a neutral loading screen instead of a route', async () => {
    vi.stubGlobal('fetch', neverAnswers);

    const app = await renderApplication();

    const loading = await app.findByRole('status');
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(loading).toHaveAttribute('aria-live', 'polite');
  });

  /**
   * The frame this whole design exists to prevent. The guards let `unknown` through on purpose, so
   * a route tree mounted during the gap would put a signed-in user on the login form and bounce
   * them off it once the answer arrived — a flash on every reload.
   */
  it('never renders the login screen on the way to knowing', async () => {
    vi.stubGlobal('fetch', neverAnswers);

    const app = await renderApplication();
    await app.findByRole('status');

    expect(app.queryByText('auth.login.title')).not.toBeInTheDocument();
    expect(app.queryByRole('main')).not.toBeInTheDocument();
  });
});

describe('when the refresh cookie is still good', () => {
  it('restores the session and lands on the page that was open', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(authenticated()));

    const app = await renderApplication();

    expect(await app.findByRole('heading', { level: 1 })).toHaveTextContent('nav.dashboard');
  });

  it('rotates once, not once per component that reads the session', async () => {
    const exchanges: string[] = [];
    vi.stubGlobal('fetch', (request: Request) => {
      exchanges.push(new URL(request.url).pathname);

      return Promise.resolve(authenticated());
    });

    const app = await renderApplication();
    await app.findByRole('main');

    // The permissions request belongs to the shell, which asks once so the navigation can hide the
    // entries this person cannot open. What this case is about is the **rotation**: one, not one per
    // component that reads the session.
    expect(exchanges.filter((path) => path.endsWith('/auth/refresh'))).toEqual([
      '/api/v1/auth/refresh',
    ]);
  });

  /**
   * CLAUDE.md invariant 3, asserted from outside the unit that keeps it: the access token lives in
   * memory for the life of the tab and is written nowhere that survives it. `units/auth` cannot
   * make this assertion itself — naming either Web Storage API in a file under that directory is
   * banned by ESLint and by `test/architecture/data-layer-conventions.test.ts`.
   */
  it('writes the access token to no storage a later script could read', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(authenticated()));

    const app = await renderApplication();
    await app.findByRole('main');

    expect(JSON.stringify({ ...localStorage })).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(ACCESS_TOKEN);
    expect(document.cookie).not.toContain(ACCESS_TOKEN);
    expect(document.body.innerHTML).not.toContain(ACCESS_TOKEN);
  });
});

describe('when there is no session to restore', () => {
  it('ends on the login screen, carrying the page that was asked for', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(refused()));
    startAt('/settings/security');

    const app = await renderApplication();

    expect(await app.findByRole('heading', { level: 1 })).toHaveTextContent('auth.login.title');
    expect(window.location.search).toContain('redirect=%2Fsettings%2Fsecurity');
  });

  /**
   * A refused bootstrap is the normal state of a visitor, not a failure: `rules/errors-and-toasts.mdc`
   * §2 gives one signal per action, and the signal here is the login screen itself. A red toast on
   * top of it would be the application complaining that nobody is signed in yet.
   */
  it('says nothing in a toast — being signed out is not an error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(refused()));

    const app = await renderApplication();
    await app.findByRole('heading', { level: 1 });

    expect(app.queryByRole('alert')).not.toBeInTheDocument();
  });
});
