import i18next from 'i18next';
import { render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Recovering an account, through the real route tree: the screen that asks for a link and the screen
 * the link leads to.
 *
 * Both are public — a person who cannot sign in is by definition not signed in — and both are built
 * around a property the API is careful about and the UI can give away for free. `forgot-password`
 * answers 202 whether or not the address is registered, so the wording has to be conditional («if
 * this address is registered…»); a screen saying «we sent you a mail» would put the enumeration
 * oracle back in the product after the server went to the trouble of not being one.
 *
 * The reset half is about the token: it arrives in the path of the SPA route, and it leaves in the
 * **body** of the request. Never a query string — that is logged by every proxy in front of the
 * installation and handed to the next origin in `Referer` (`docs/security/threat-model.md`,
 * T-IAM-07).
 */
const TOKEN = 'example-only-not-a-real-reset-token';

const EMAIL = 'ada@example.com';
const OTHER_EMAIL = 'nobody@example.com';
const NEW_PASSWORD = 'staple-generator-lantern';

interface RecordedRequest {
  readonly pathname: string;
  readonly search: string;
  readonly body: string;
}

const problem = (code: string, status: number): Response =>
  new Response(
    JSON.stringify({
      type: `https://bad-crm.dev/problems/${code}`,
      title: code,
      status,
      code,
      requestId: 'req-1',
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

/** What the two recovery operations answer, per case. */
let answer: (pathname: string) => Response = () => new Response(null, { status: 202 });

const api = (requests: RecordedRequest[]) => async (request: Request) => {
  const { pathname, search } = new URL(request.url);
  requests.push({ pathname, search, body: await request.clone().text() });

  // Nothing to restore a session from: every case here starts anonymous, which is the state the
  // whole flow exists for.
  if (pathname.endsWith('/auth/refresh')) return new Response(null, { status: 401 });

  return answer(pathname);
};

const platformFetch = globalThis.fetch;

type Screen = ReturnType<typeof within>;

interface StartedScreen {
  readonly screen: Screen;
  /** The tree this case mounted — what `axe` is pointed at, so it never sees a previous one. */
  readonly container: HTMLElement;
}

let unsubscribe: (() => void) | undefined;

const startApplicationAt = async (
  path: string,
  requests: RecordedRequest[],
): Promise<StartedScreen> => {
  vi.resetModules();
  vi.stubGlobal('fetch', api(requests));
  window.history.pushState({}, '', path);

  const [
    { App },
    { installApiMiddleware },
    { subscribeAuthEvents },
    { router },
    { appQueryClient },
    { AuthService },
  ] = await Promise.all([
    import('@app'),
    import('@app/api-middleware.util.js'),
    import('@app/auth-events.util.js'),
    import('@app/router.js'),
    import('@app/app-query-client.constant.js'),
    import('@units/auth'),
  ]);

  installApiMiddleware();
  unsubscribe = subscribeAuthEvents({
    router,
    queryClient: appQueryClient,
    session: AuthService.authSession,
  });

  // Scoped to the tree this case mounted: every case mounts a whole application, and a
  // document-wide query would also see what the previous one left behind.
  const { container } = render(<App i18n={i18next} />);
  const screen = within(container);
  await screen.findByRole('heading', { level: 1 });

  return { screen, container };
};

/**
 * Toasts are queried against the document, not against the mounted tree.
 *
 * `@mantine/notifications` renders through a portal appended to `document.body`, which is outside
 * the container `render` returns — a screen scoped to the tree would report «no toast» for a toast
 * that is on the page. Testing Library unmounts the tree between cases, and the portal with it, so
 * a document-wide query here still sees only this case's notifications.
 */
const toasts = () => within(document.body);

const askForALink = async (
  user: ReturnType<typeof userEvent.setup>,
  screen: Screen,
  email: string,
) => {
  await user.type(screen.getByLabelText(/auth\.forgotPassword\.email\.label/), email);
  await user.click(screen.getByRole('button', { name: 'auth.forgotPassword.submit' }));
};

const setNewPassword = async (
  user: ReturnType<typeof userEvent.setup>,
  screen: Screen,
  password: string,
) => {
  await user.type(screen.getByLabelText(/auth\.resetPassword\.newPassword\.label/), password);
  await user.type(screen.getByLabelText(/auth\.resetPassword\.confirmPassword\.label/), password);
  await user.click(screen.getByRole('button', { name: 'auth.resetPassword.submit' }));
};

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  answer = () => new Response(null, { status: 202 });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  vi.stubGlobal('fetch', platformFetch);
});

describe('asking for a reset link', () => {
  it('sends the address and confirms in words that do not say whether it exists', async () => {
    const user = userEvent.setup();
    const requests: RecordedRequest[] = [];
    const { screen } = await startApplicationAt('/forgot-password', requests);

    await askForALink(user, screen, EMAIL);

    const confirmation = await screen.findByText('auth.forgotPassword.sent');
    expect(confirmation.closest('[role="status"]')).not.toBeNull();
    expect(
      requests.filter((request) => request.pathname === '/api/v1/auth/forgot-password'),
    ).toEqual([
      {
        pathname: '/api/v1/auth/forgot-password',
        search: '',
        body: JSON.stringify({ email: EMAIL }),
      },
    ]);
  });

  /**
   * The property, asserted rather than described. The server answers 202 to both addresses, and the
   * screen has nowhere to put the difference: one key, one panel, no branch on what was typed.
   */
  it('says exactly the same thing for an address that is not registered', async () => {
    const user = userEvent.setup();
    const { screen } = await startApplicationAt('/forgot-password', []);

    await askForALink(user, screen, OTHER_EMAIL);

    expect(await screen.findByText('auth.forgotPassword.sent')).toBeInTheDocument();
    expect(screen.queryByLabelText(/auth\.forgotPassword\.email\.label/)).not.toBeInTheDocument();
  });

  it('does not ask the server for an address that is not one', async () => {
    const user = userEvent.setup();
    const requests: RecordedRequest[] = [];
    const { screen } = await startApplicationAt('/forgot-password', requests);

    await askForALink(user, screen, 'ada');

    expect(await screen.findByText('validation.email.invalid')).toBeInTheDocument();
    expect(requests.some((request) => request.pathname.endsWith('/auth/forgot-password'))).toBe(
      false,
    );
  });

  /**
   * An installation with no `SMTP_URL` refuses every request with 503, before the address is even
   * resolved. It is a failed operation, so it is one red toast from the global `MutationCache`
   * handler — and the form stays, because the person can retry once the operator has configured a
   * transport (`rules/errors-and-toasts.mdc` §3).
   */
  it('reports a refusal as a toast and keeps the form', async () => {
    const user = userEvent.setup();
    answer = () => problem('mail_not_configured', 503);
    const { screen } = await startApplicationAt('/forgot-password', []);

    await askForALink(user, screen, EMAIL);

    expect(await toasts().findByText('errors.mail_not_configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'auth.forgotPassword.submit' })).toBeInTheDocument();
    expect(screen.queryByText('auth.forgotPassword.sent')).not.toBeInTheDocument();
  });

  it('has no accessibility violation', async () => {
    const { container } = await startApplicationAt('/forgot-password', []);

    const { violations } = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe('spending a reset link', () => {
  it('sends the token in the body, never in the URL, and lands on the login screen', async () => {
    const user = userEvent.setup();
    const requests: RecordedRequest[] = [];
    answer = () => new Response(null, { status: 204 });
    const { screen } = await startApplicationAt(`/reset-password/${TOKEN}`, requests);

    await setNewPassword(user, screen, NEW_PASSWORD);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/login');
    });

    const reset = requests.filter((request) => request.pathname === '/api/v1/auth/reset-password');
    expect(reset).toEqual([
      {
        pathname: '/api/v1/auth/reset-password',
        search: '',
        body: JSON.stringify({ token: TOKEN, newPassword: NEW_PASSWORD }),
      },
    ]);
    expect(await toasts().findByText('auth.resetPassword.success')).toBeInTheDocument();
  });

  /**
   * What the tab is still holding once the reset is done — and it must be nothing.
   *
   * The token travelled in the body rather than the query string so that it would not reach a proxy
   * log; `Referrer-Policy: no-referrer` keeps it out of `Referer`. Both are undone if it simply stays
   * in the mutation cache afterwards, because that cache is reachable from `self.__TSR_ROUTER__` —
   * `@tanstack/router-core` assigns it for every router in a document, with no development flag — and
   * `state.variables` is kept beside `state.data` for the whole `gcTime`.
   *
   * The password matters more than the token here: the token is spent by the time this runs, while
   * the password is reusable and would otherwise sit in memory for five minutes after the person has
   * been redirected to the login screen. Asserted through the real screen rather than on the hook,
   * because this is the arrangement that ships.
   */
  it('leaves neither the token nor the new password in the query cache', async () => {
    const user = userEvent.setup();
    const requests: RecordedRequest[] = [];
    answer = () => new Response(null, { status: 204 });
    const { screen } = await startApplicationAt(`/reset-password/${TOKEN}`, requests);

    await setNewPassword(user, screen, NEW_PASSWORD);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/login');
    });

    const { appQueryClient } = await import('@app/app-query-client.constant.js');

    await waitFor(() => {
      const cached = JSON.stringify(
        appQueryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state),
      );

      expect(cached).not.toContain(NEW_PASSWORD);
      expect(cached).not.toContain(TOKEN);
    });
  });

  /**
   * Unknown, already spent and expired are one answer by design — telling them apart would let the
   * holder of a guessed token learn whether it ever existed. The screen therefore has one refusal to
   * render, and what it owes the person is the way out: the link that asks for a new mail is on the
   * page before anything fails and stays there afterwards.
   */
  it('reports a link that no longer works, and offers to ask for a new one', async () => {
    const user = userEvent.setup();
    answer = () => problem('password_reset_token_invalid', 400);
    const { screen } = await startApplicationAt(`/reset-password/${TOKEN}`, []);

    await setNewPassword(user, screen, NEW_PASSWORD);

    expect(await toasts().findByText('errors.password_reset_token_invalid')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'auth.resetPassword.requestNewLink' }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/reset-password/${TOKEN}`);
  });

  it('does not spend the token on a password the policy would refuse', async () => {
    const user = userEvent.setup();
    const requests: RecordedRequest[] = [];
    const { screen } = await startApplicationAt(`/reset-password/${TOKEN}`, requests);

    await setNewPassword(user, screen, 'short');

    expect(await screen.findByText('validation.password.too_short')).toBeInTheDocument();
    expect(requests.some((request) => request.pathname.endsWith('/auth/reset-password'))).toBe(
      false,
    );
  });

  it('has no accessibility violation', async () => {
    const { container } = await startApplicationAt(`/reset-password/${TOKEN}`, []);

    const { violations } = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
  });
});

describe('finding the way in', () => {
  it('offers the recovery screen from the sign-in form', async () => {
    const { screen } = await startApplicationAt('/login', []);

    expect(screen.getByRole('link', { name: 'auth.login.forgotPassword' })).toBeInTheDocument();
  });
});
