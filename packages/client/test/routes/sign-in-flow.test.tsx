import i18next from 'i18next';
import { render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCimodeLanguage } from '../support/test-language.util.js';

/**
 * The whole round trip, through the real entry point: a protected URL without a session, the login
 * screen, the sign-in, the return to the page that was asked for, and the way back out.
 *
 * It assembles what `main.tsx` assembles — the middleware, the bus subscription, the tree — rather
 * than importing `main.tsx` itself, and the reason is that the entry point mounts a root nobody can
 * unmount. `units/auth` announces `logged-in` and `logged-out` on a bus and knows nothing about a
 * router; `app/auth-events.util.ts` is the subscriber that turns those into `router.invalidate()`
 * and a navigation; both are exercised here. Mounting through the entry point five times over would
 * leave five live routers listening to one browser history, and the first one — still anonymous —
 * would bounce every navigation the others made straight back to the login screen, for ever.
 * `test/app/boot.test.tsx` is where the entry point itself is proved.
 *
 * The transport is one stub that answers by path, so the sequence of requests is the sequence a
 * browser would make.
 */
const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const PROTECTED_URL = '/dashboard?range=30d&scope=org';

const EMAIL = 'ada@example.com';
const PASSWORD = 'correct-horse-battery';

const ACCESS_TOKEN = 'access-token-1';

/**
 * What `@tanstack/router-core` publishes on `globalThis` for every router it builds — the walk an
 * injected script would take. Declared as the narrow shape this suite reads rather than as the
 * router type, so the assertion describes the reachable path instead of the library.
 */
interface PublishedRouter {
  readonly __TSR_ROUTER__?: {
    readonly options: {
      readonly context: {
        readonly queryClient: {
          readonly getMutationCache: () => { readonly getAll: () => readonly { state: unknown }[] };
        };
      };
    };
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const session = () =>
  json({
    status: 'authenticated',
    accessToken: ACCESS_TOKEN,
    tokenType: 'Bearer',
    expiresIn: 900,
    user: { id: USER_ID, email: EMAIL, locale: 'en', timezone: 'Europe/Berlin' },
    organization: { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
  });

/**
 * Whether the server still knows this session.
 *
 * A flag rather than a second `vi.stubGlobal`, because `openapi-fetch` captures `globalThis.fetch`
 * when the client is built: a transport swapped after the application has started is a transport
 * the application never sees. Flipping it is the closest a runner gets to what actually happens —
 * the refresh family revoked while the tab is open, by an expiry, by a password reset elsewhere or
 * by an administrator.
 */
let sessionRevoked = false;

/** No cookie to restore from, a sign-in that works, a sign-out that is accepted. */
const api = (requests: string[]) => (request: Request) => {
  const { pathname } = new URL(request.url);
  requests.push(pathname);

  if (sessionRevoked) return Promise.resolve(new Response(null, { status: 401 }));
  if (pathname.endsWith('/auth/login')) return Promise.resolve(session());
  if (pathname.endsWith('/auth/logout'))
    return Promise.resolve(new Response(null, { status: 204 }));

  return Promise.resolve(new Response(null, { status: 401 }));
};

const platformFetch = globalThis.fetch;

type App = ReturnType<typeof within>;

const signIn = async (user: ReturnType<typeof userEvent.setup>, app: App) => {
  await user.type(app.getByLabelText(/auth\.login\.email\.label/), EMAIL);
  await user.type(app.getByLabelText(/auth\.login\.password\.label/), PASSWORD);
  await user.click(app.getByRole('button', { name: 'auth.login.submit' }));
};

let unsubscribe: (() => void) | undefined;

interface StartedApplication {
  readonly app: App;
  /** The session store of the tab that was just started — what the guards read. */
  readonly authSession: { readonly read: () => { readonly status: string } };
  /** The one API client of that tab, for the request a screen has not been built to make yet. */
  readonly apiClient: { readonly GET: (path: '/meta') => Promise<unknown> };
}

const startApplication = async (requests: string[]): Promise<StartedApplication> => {
  vi.resetModules();
  vi.stubGlobal('fetch', api(requests));
  window.history.pushState({}, '', PROTECTED_URL);

  const [
    { App },
    { installApiMiddleware },
    { subscribeAuthEvents },
    { router },
    { appQueryClient },
    { AuthService },
    { SharedApi },
  ] = await Promise.all([
    import('@app'),
    import('@app/api-middleware.util.js'),
    import('@app/auth-events.util.js'),
    import('@app/router.js'),
    import('@app/app-query-client.constant.js'),
    import('@units/auth'),
    import('@shared'),
  ]);

  installApiMiddleware();
  unsubscribe = subscribeAuthEvents({
    router,
    queryClient: appQueryClient,
    session: AuthService.authSession,
  });

  // Scoped to the tree this case mounted rather than to `document.body`: each case mounts a whole
  // application, and a document-wide query would also see whatever the previous one left behind.
  const app = within(render(<App i18n={i18next} />).container);
  await app.findByRole('heading', { level: 1 });

  return { app, authSession: AuthService.authSession, apiClient: SharedApi.apiClient };
};

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  setCimodeLanguage();
  sessionRevoked = false;
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  vi.stubGlobal('fetch', platformFetch);
});

describe('signing in from a link to a protected page', () => {
  it('asks for credentials first, remembering where the visitor was going', async () => {
    const { app } = await startApplication([]);

    // Waited for by name, not read once: the starter resolves as soon as **a** level-1 heading
    // appears, and the guard's redirect replaces the tree a commit later. On a fast machine the
    // redirect has already happened; on a loaded CI runner the first heading is the one before it,
    // and the assertion met an empty tree («Unable to find role=heading», CI 2026-08-05). Waiting
    // for the heading of the sign-in screen is the property this case is about.
    expect(
      await app.findByRole('heading', { level: 1, name: 'auth.login.title' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
    expect(decodeURIComponent(window.location.search)).toContain(`redirect=${PROTECTED_URL}`);
  });

  /**
   * The acceptance in one case: after the sign-in the guards are re-checked without a reload, and
   * the user lands on the page they originally asked for — search parameters and all — rather than
   * on the dashboard the fallback would have chosen.
   */
  it('returns the visitor to that page once the session exists', async () => {
    const user = userEvent.setup();
    const { app } = await startApplication([]);

    await signIn(user, app);

    // The URL changes when the guard fires; the screen follows on the next commit, so the
    // assertion that matters is the one that waits for the content.
    expect(
      await app.findByText('dashboard.range.last30Days · dashboard.scope.org'),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe('/dashboard');
    expect(app.getByRole('heading', { level: 1 })).toHaveTextContent('nav.dashboard');
  });

  it('makes one sign-in request, and no rotation after it', async () => {
    const user = userEvent.setup();
    const requests: string[] = [];
    const { app } = await startApplication(requests);

    await signIn(user, app);
    await waitFor(() => {
      expect(window.location.pathname).toBe('/dashboard');
    });

    expect(requests).toEqual(['/api/v1/auth/refresh', '/api/v1/auth/login']);
  });

  /**
   * The access token must not be reachable from anything a script on the page can walk to.
   *
   * The walk is real, not hypothetical: `@tanstack/router-core` assigns `self.__TSR_ROUTER__ = this`
   * for every router built in a document, with no development guard
   * (`router-core/dist/esm/router.js`). From there the router context carries the `QueryClient`, and
   * `getMutationCache().getAll()[…].state.data` is whatever the sign-in mutation returned — for five
   * minutes by default, long after the form is gone. Returning the whole `AuthenticatedSession` from
   * `mutationFn` put the token in that cache; mapping it in the mutation function is what keeps the
   * token in the one module variable that is supposed to hold it (CLAUDE.md, invariant 3).
   */
  it('leaves no access token in the cache the published router reaches', async () => {
    const user = userEvent.setup();
    const { app } = await startApplication([]);

    await signIn(user, app);
    await waitFor(() => {
      expect(window.location.pathname).toBe('/dashboard');
    });

    const published = (globalThis as unknown as PublishedRouter).__TSR_ROUTER__;
    const queryClient = published?.options.context.queryClient;
    const states =
      queryClient
        ?.getMutationCache()
        .getAll()
        .map((mutation) => mutation.state) ?? [];

    // The traversal is real — this is the positive control, and it replaced an earlier one.
    //
    // It used to be `expect(states).not.toHaveLength(0)`: the cache had to hold *something* or the
    // «does not contain the token» assertion below would have been a claim about an empty string. That
    // control stopped being available once the login mutation took `gcTime: 0`, which removes its
    // entry — variables included, and those are the address and the password — the moment the form
    // unmounts. So the proof that the walk resolves moved onto the walk itself: if the path through
    // `__TSR_ROUTER__` to the client were wrong, this would be `undefined` and `?? []` would hide it.
    expect(published).toBeDefined();
    expect(queryClient).toBeDefined();

    // Nothing at all, which is stronger than «nothing containing the token» and is the actual
    // property now. The substring assertion stays for the day some other mutation is cached here.
    expect(states).toHaveLength(0);
    expect(JSON.stringify(states)).not.toContain(ACCESS_TOKEN);
  });
});

/**
 * The session ends where it started — on the server — and the tab has to notice.
 *
 * A refresh family is revoked by more than a sign-out: the token expires, a password reset elsewhere
 * revokes every family of the account, an administrator closes the session. What the tab sees is a
 * 401 on an ordinary request, a refused rotation, and then nothing at all unless somebody moves the
 * session state to `anonymous` — because `redirectIfAuthed` reads that state on `/login` and throws
 * a still-`authenticated` tab straight back into the shell it was ejected from, while
 * `requireSession` waves it through. The cache is empty by then and every request is a 401: an
 * application that says the user is signed in, shows nothing, and offers no way back in.
 */
describe('when the server closes the session under the tab', () => {
  it('ends the session and shows the login form instead of trapping the user in the shell', async () => {
    const user = userEvent.setup();
    const { app, authSession, apiClient } = await startApplication([]);
    await signIn(user, app);
    await waitFor(() => {
      expect(window.location.pathname).toBe('/dashboard');
    });

    sessionRevoked = true;
    // Any request would do; `/meta` is the one operation of the contract that needs no screen. It
    // travels through the same middleware as everything else, which is what turns the 401 into a
    // refused rotation and the refused rotation into `logged-out`.
    await apiClient.GET('/meta');

    await waitFor(() => {
      expect(window.location.pathname).toBe('/login');
    });
    expect(authSession.read()).toEqual({ status: 'anonymous' });
    expect(app.getByRole('heading', { level: 1 })).toHaveTextContent('auth.login.title');
    expect(decodeURIComponent(window.location.search)).toContain('redirect=/dashboard');
  });
});

describe('signing out', () => {
  it('ends the session and returns to the login screen', async () => {
    const user = userEvent.setup();
    const { app } = await startApplication([]);
    await signIn(user, app);
    await waitFor(() => {
      expect(window.location.pathname).toBe('/dashboard');
    });

    await user.click(app.getByRole('button', { name: 'nav.signOut' }));

    await waitFor(() => {
      expect(window.location.pathname).toBe('/login');
    });
    expect(app.getByRole('heading', { level: 1 })).toHaveTextContent('auth.login.title');
  });

  /**
   * The tab must not be able to restore what it has just left: `bootstrap()` is memoised for the
   * life of the store, so nothing asks `POST /auth/refresh` again, and the login screen that
   * appears is a real one rather than a frame before a silent restore.
   */
  it('does not try to restore the session it has just ended', async () => {
    const user = userEvent.setup();
    const requests: string[] = [];
    const { app } = await startApplication(requests);
    await signIn(user, app);
    await waitFor(() => {
      expect(window.location.pathname).toBe('/dashboard');
    });

    await user.click(app.getByRole('button', { name: 'nav.signOut' }));
    await waitFor(() => {
      expect(window.location.pathname).toBe('/login');
    });

    expect(requests.filter((path) => path.endsWith('/auth/refresh'))).toHaveLength(1);
  });
});
