import i18next from 'i18next';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderApp } from '../support/render-app.util.js';
import { setCimodeLanguage } from '../support/test-language.util.js';

/**
 * The forced enrolment, through the real entry point: a session the organization's second-factor
 * policy has scoped, the wizard it is sent to, the door out of it, and the way back into the
 * application once the second factor exists (STORY-013-05 acceptance 3, STORY-013-04 acceptance 8).
 *
 * **Why the whole application rather than the page.** Every interesting property of this feature is
 * a property of the *seam*, not of a component: the guard on the protected branch, the guard on the
 * wizard, the rotation that changes what those guards read, and the bus event that makes the router
 * ask them again. A test that mounted the page would have proved that a heading renders — which is
 * the one thing about this screen nobody was worried about. It follows `sign-in-flow.test.tsx` in
 * assembling what `main.tsx` assembles rather than importing the entry point itself, for the reason
 * that file records: an entry point mounts a root nobody can unmount, and five live routers over
 * one history fight each other.
 *
 * **Why the scope is a variable of the fixture.** `mfaEnrollment` is minted where a session is
 * issued and re-decided on every rotation, so «the enrolment finished» is not an event the client
 * is told about — it is the next refresh answering differently. Flipping a flag between the
 * confirmation and the rotation is exactly that fact, and it is what makes the last case below able
 * to fail: with the page navigating by itself, it would pass with the flag never read.
 */
const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const PASSWORD = 'correct-horse-battery';
const CODE = '123456';

const CODES = [
  '23456ABCDE',
  'FGHJKMNPQR',
  'STUVWXYZ23',
  '456789ABCD',
  'EFGHJKMNPQ',
  'RSTUVWXYZ2',
  '3456789ABC',
  'DEFGHJKMNP',
  'QRSTUVWXYZ',
  '23456789AB',
];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Whether the policy still holds this account to enrolment.
 *
 * A module flag rather than a second `vi.stubGlobal`, for the reason `sign-in-flow.test.tsx` gives:
 * `openapi-fetch` captures `globalThis.fetch` when the client is built, so a transport swapped
 * after the application has started is a transport the application never sees.
 */
let scoped = true;

/**
 * Held open by a case that needs to look at the screen *during* the completion rotation.
 *
 * `null` means «answer immediately», which is what every other case wants. Set to a deferred
 * promise, the second `POST /auth/refresh` — the one `finish` starts — hangs until the case
 * releases it, which is the only way to observe a state that otherwise lasts one microtask.
 */
let heldRotation: { readonly promise: Promise<void>; readonly release: () => void } | null = null;

const deferred = () => {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });

  return { promise, release };
};

const session = () =>
  json({
    status: 'authenticated',
    accessToken: 'access-token-1',
    tokenType: 'Bearer',
    expiresIn: 900,
    user: { id: USER_ID, email: 'ada@example.com', locale: 'en', timezone: 'Europe/Berlin' },
    organization: { id: ORGANIZATION_ID, name: 'Bad Company', slug: 'bad-company' },
    // Absent rather than `false` once the enrolment is done — the shape the server actually sends.
    ...(scoped ? { mfaEnrollment: true, mfaGraceEndsAt: '2026-09-12T12:00:00.000Z' } : {}),
  });

const noPermissions = () =>
  json({ permissions: [], denied: [], roles: [], isOwner: false, version: 1 });

const api = (requests: string[]) => (request: Request) => {
  const { pathname } = new URL(request.url);
  requests.push(pathname);

  if (pathname.endsWith('/auth/refresh')) {
    return heldRotation === null
      ? Promise.resolve(session())
      : heldRotation.promise.then(() => session());
  }
  if (pathname.endsWith('/auth/2fa/setup')) {
    return Promise.resolve(
      json({
        secret: 'JBSWY3DPEHPK3PXP',
        uri: 'otpauth://totp/BadCRM:ada@example.com?secret=JBSWY3DPEHPK3PXP',
        qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
      }),
    );
  }
  if (pathname.endsWith('/auth/2fa/confirm')) {
    // The enrolment is what ends the scope, and the server decides that at the next rotation.
    scoped = false;

    return Promise.resolve(json({ codes: CODES }));
  }
  if (pathname.endsWith('/auth/logout'))
    return Promise.resolve(new Response(null, { status: 204 }));
  if (pathname.endsWith('/me/permissions')) return Promise.resolve(noPermissions());

  return Promise.resolve(new Response(null, { status: 401 }));
};

const platformFetch = globalThis.fetch;

type App = ReturnType<typeof within>;

let unsubscribe: (() => void) | undefined;

interface StartedApplication {
  readonly app: App;
  readonly router: { readonly state: { readonly location: { readonly pathname: string } } };
}

/** Starts the application at `path`, with whatever `scoped` currently says about the session. */
const startApplication = async (
  requests: string[],
  path = '/dashboard',
): Promise<StartedApplication> => {
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

  const app = within(render(<App i18n={i18next} />).container);
  await app.findByRole('heading', { level: 1 });

  return { app, router };
};

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  setCimodeLanguage();
  scoped = true;
  heldRotation = null;
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  vi.stubGlobal('fetch', platformFetch);
});

describe('a session the organization has scoped to enrolment', () => {
  it('is taken to the wizard instead of the page it asked for', async () => {
    const { app, router } = await startApplication([]);

    expect(router.state.location.pathname).toBe('/mfa-enrolment');
    expect(app.getByRole('heading', { level: 1 })).toHaveTextContent('security.enrolment.title');
  });

  /**
   * The shell is what the scope makes a lie: every entry in it opens a route the server answers
   * with 403 `mfa_enrollment_required`. Asserted through the landmark rather than through a link,
   * because the argument is «none of it is drawn», not «this one entry is missing».
   */
  it('is shown no navigation it cannot use', async () => {
    const { app } = await startApplication([]);

    expect(app.queryByRole('banner')).toBeNull();
    expect(app.queryByRole('navigation')).toBeNull();
  });

  /** Why the person is here, in a sentence, rather than a wizard that appeared for no reason. */
  it('is told why it is here', async () => {
    const { app } = await startApplication([]);

    expect(app.getByText('security.enrolment.reason')).toBeInTheDocument();
  });

  /**
   * The one door out, and the reason it has to be on this screen: `POST /auth/logout` is one of the
   * three routes the server leaves open to a scoped session, and without it somebody who does not
   * want to enrol right now has no action available but closing the tab.
   */
  it('can sign out, which is the only other thing the server lets it do', async () => {
    const requests: string[] = [];
    const { app } = await startApplication(requests);
    const user = userEvent.setup();

    await user.click(app.getByRole('button', { name: 'security.enrolment.signOut' }));

    await waitFor(() => {
      expect(requests).toContain('/api/v1/auth/logout');
    });
  });

  it('cannot walk into the application by typing the address', async () => {
    const { router } = await startApplication([], '/settings/security');

    expect(router.state.location.pathname).toBe('/mfa-enrolment');
  });
});

describe('finishing the enrolment', () => {
  /**
   * The whole point of the screen, in one pass: pair an authenticator, save the ten codes, and be
   * in the application — **without reloading the tab**, which is what «the client never learns the
   * scope changed» would have cost.
   */
  it('carries the person into the application once the session is no longer scoped', async () => {
    const requests: string[] = [];
    const { app, router } = await startApplication(requests);
    const user = userEvent.setup();

    await user.click(app.getByRole('button', { name: 'security.totp.enable' }));

    await user.type(await app.findByLabelText(/security\.totp\.code\.label/), CODE);
    await user.type(app.getByLabelText(/security\.totp\.password\.label/), PASSWORD);
    await user.click(app.getByRole('button', { name: 'security.totp.confirm' }));

    // `screen` rather than the mounted container: a Mantine `Modal` renders through a portal on
    // `document.body`, so a query scoped to the tree the case rendered never sees it.
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(CODES[0] ?? '')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'security.codes.dialog.done' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/dashboard');
    });

    // The rotation is how it learned: two refreshes, the bootstrap and the one the completion asked
    // for. Without the second, the guard would still be reading the scoped session it started with.
    expect(requests.filter((path) => path.endsWith('/auth/refresh'))).toHaveLength(2);
  });
});

describe('the wizard for somebody the policy does not hold', () => {
  it('carries an ordinary session back into the application', async () => {
    scoped = false;

    const { router } = await startApplication([], '/mfa-enrolment');

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/dashboard');
    });
  });

  /**
   * Through `renderApp` rather than the entry point, and the difference is the history. The cases
   * above mount the real application over the browser's one history, which they share; a case about
   * *arriving* at this address cannot then trust that the address is still the one it pushed. The
   * memory history of `renderApp` is one per case, and the guard under test is the same object.
   */
  it('sends an anonymous visitor to the sign-in screen, remembering the address', async () => {
    const { router } = renderApp({ path: '/mfa-enrolment', status: 'anonymous' });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
    expect(router.state.location.searchStr).toContain('mfa-enrolment');
  });
});

/**
 * What the screen does between «I have saved the codes» and the guard carrying the person away.
 *
 * That window is one network round trip long, and nothing about it is visible unless the rotation is
 * held open — which is why this describe exists at all rather than being folded into the pass above.
 *
 * Both properties in it were defects when they were written, and both were found by reading rather
 * than by a failing assertion: `RecoveryCodesDialog.close()` aims focus at the page heading in a
 * microtask **on the assumption that `onConfirmed` has already unmounted it** (the invariant its own
 * docstring states, and the one `/settings/security` honours). A completion that dropped the codes
 * only after the rotation left the trap live while focus was pulled out of it — on the one screen a
 * person cannot leave.
 */
describe('the moment between saving the codes and landing', () => {
  const enrolThroughTheDialog = async (
    app: App,
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> => {
    await user.click(app.getByRole('button', { name: 'security.totp.enable' }));
    await user.type(await app.findByLabelText(/security\.totp\.code\.label/), CODE);
    await user.type(app.getByLabelText(/security\.totp\.password\.label/), PASSWORD);
    await user.click(app.getByRole('button', { name: 'security.totp.confirm' }));

    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'security.codes.dialog.done' }));
  };

  it('closes the dialog at once and puts focus back on the heading', async () => {
    const { app } = await startApplication([]);
    const user = userEvent.setup();

    heldRotation = deferred();
    await enrolThroughTheDialog(app, user);

    // The rotation has not answered, so nothing has navigated yet — and the dialog is already gone,
    // which is what makes the focus move below legal rather than a jump out of a live trap.
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(app.getByRole('heading', { level: 1 }));
    });

    heldRotation.release();
  });

  /**
   * And it does not invite the person to do again what they have just done. Dropping the codes puts
   * the wizard back to whatever it derives from the mutations, and «no draft, not enrolled» is the
   * face with the «Turn on two-factor authentication» button on it — a button that would answer 409
   * for an account the server has already enrolled.
   */
  it('says the second factor is on rather than offering to turn it on', async () => {
    const { app } = await startApplication([]);
    const user = userEvent.setup();

    heldRotation = deferred();
    await enrolThroughTheDialog(app, user);

    expect(app.getByText('security.totp.status.on')).toBeInTheDocument();
    expect(app.queryByRole('button', { name: 'security.totp.enable' })).toBeNull();

    heldRotation.release();
  });
});
