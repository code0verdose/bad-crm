import i18next from 'i18next';
import { render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCimodeLanguage, setTestLanguage } from '../support/test-language.util.js';

/**
 * Creating the first organization of an installation, through the real route tree.
 *
 * This is the one screen the product cannot be used without and the one nothing else can reach: it
 * runs with no session, and the account that would satisfy every guard is what it creates. Until
 * this story it did not exist at all — an installation was bootstrapped with a request to the API or
 * with the seed — so what these cases are really asserting is that the door is now in the building.
 *
 * Three properties beyond the happy path, all of them about *where a refusal is shown*. The screen
 * places all three of its refusals itself and the mutation's local `onError` keeps a toast from
 * landing on top of any of them (`rules/errors-and-toasts.mdc` §2–§4): a taken slug under the slug
 * field, a closed installation in place of the form, everything else above the fields.
 */
const ORGANIZATION = 'Bad Company';
const SLUG = 'bad-company';
const EMAIL = 'ada@example.com';
const PASSWORD = 'staple-generator-lantern';

const USER_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

interface RecordedRequest {
  readonly pathname: string;
  readonly search: string;
  readonly body: string;
  readonly idempotencyKey: string | null;
}

const problem = (
  code: string,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): Response =>
  new Response(
    JSON.stringify({
      type: `https://bad-crm.dev/problems/${code}`,
      title: code,
      status,
      code,
      requestId: 'req-1',
    }),
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );

const session = (): Response =>
  new Response(
    JSON.stringify({
      status: 'authenticated',
      accessToken: 'access-token-of-the-owner',
      tokenType: 'Bearer',
      expiresIn: 900,
      user: { id: USER_ID, email: EMAIL, locale: 'en', timezone: 'Europe/Berlin' },
      organization: { id: ORGANIZATION_ID, name: ORGANIZATION, slug: SLUG },
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );

/** What `POST /auth/register` answers, per case. */
let answer: () => Response = session;

const api = (requests: RecordedRequest[]) => async (request: Request) => {
  const { pathname, search } = new URL(request.url);

  // Nothing to restore a session from: every case starts anonymous, which is the state the screen
  // exists for. Everything the shell asks for after a session appears is answered with an empty
  // document — the assertion is that the application was reached, not what it then rendered.
  if (pathname.endsWith('/auth/refresh')) return new Response(null, { status: 401 });

  if (!pathname.endsWith('/auth/register')) {
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  requests.push({
    pathname,
    search,
    body: await request.clone().text(),
    idempotencyKey: request.headers.get('idempotency-key'),
  });

  return answer();
};

const platformFetch = globalThis.fetch;

type Screen = ReturnType<typeof within>;

interface StartedScreen {
  readonly screen: Screen;
  /** The tree this case mounted — what `axe` is pointed at, so it never sees a previous one. */
  readonly container: HTMLElement;
}

let unsubscribe: (() => void) | undefined;

/**
 * `language` names a real catalogue to mount with instead of the suite's `cimode` instance — the
 * one case that asserts a *sentence* rather than a key needs one, for the reason it states.
 */
const startApplicationAt = async (
  path: string,
  requests: RecordedRequest[],
  language?: 'en' | 'ru',
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
    { SharedI18n },
  ] = await Promise.all([
    import('@app'),
    import('@app/api-middleware.util.js'),
    import('@app/auth-events.util.js'),
    import('@app/router.js'),
    import('@app/app-query-client.constant.js'),
    import('@units/auth'),
    import('@shared'),
  ]);

  const i18n = language === undefined ? i18next : SharedI18n.createI18n(language);
  if (language !== undefined) setTestLanguage(language);

  installApiMiddleware();
  unsubscribe = subscribeAuthEvents({
    router,
    queryClient: appQueryClient,
    session: AuthService.authSession,
    recentProjects: (await import('@units/project')).ProjectService.ProjectStores.recentProjects,
  });

  const { container } = render(<App i18n={i18n} />);
  const screen = within(container);
  await screen.findByRole('heading', { level: 1 });

  return { screen, container };
};

/**
 * Only the notification region, never the whole document.
 *
 * Toasts render through a portal appended to `document.body` — but so does the mounted application,
 * and three cases below assert that a sentence appears **on the screen** and *not* in a toast. A
 * query over `document.body` finds the inline message and reports a toast that was never raised,
 * which is a green «no toast» assertion away from being a false failure in both directions.
 */
const toasts = () => {
  const region = document.querySelector<HTMLElement>('.mantine-Notifications-root');

  return within(region ?? document.createElement('div'));
};

const registerWith = async (
  user: ReturnType<typeof userEvent.setup>,
  screen: Screen,
  slug: string = SLUG,
) => {
  await user.type(screen.getByLabelText(/auth\.register\.organizationName\.label/), ORGANIZATION);
  await user.type(screen.getByLabelText(/auth\.register\.slug\.label/), slug);
  await user.type(screen.getByLabelText(/auth\.register\.email\.label/), EMAIL);
  await user.type(screen.getByLabelText(/auth\.register\.password\.label/), PASSWORD);
  await user.type(screen.getByLabelText(/auth\.register\.confirmPassword\.label/), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'auth.register.submit' }));
};

/**
 * The same five fields, found by their shape rather than by their label.
 *
 * `registerWith` above queries labels by key, which only exists under `cimode`; the one case that
 * runs under a real catalogue has English labels on screen, and matching those would be writing the
 * catalogue out a second time. `autocomplete` is part of the contract with the browser, not with the
 * translator, so it is the same under every language.
 */
const registerByShape = async (
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
) => {
  const field = (selector: string): HTMLElement => {
    const element = container.querySelector<HTMLElement>(selector);

    if (element === null) throw new Error(`no field matches ${selector}`);

    return element;
  };

  await user.type(field('input[autocomplete="organization"]'), ORGANIZATION);
  await user.type(field('input[autocomplete="off"]'), SLUG);
  await user.type(field('input[type="email"]'), EMAIL);
  const [password, confirmation] = container.querySelectorAll<HTMLElement>(
    'input[autocomplete="new-password"]',
  );
  await user.type(password as HTMLElement, PASSWORD);
  await user.type(confirmation as HTMLElement, PASSWORD);
  await user.click(field('button[type="submit"]'));
};

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  setCimodeLanguage();
  answer = session;
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  vi.stubGlobal('fetch', platformFetch);
});

describe('registering an organization', () => {
  it('refuses a slug that is not one without asking the server', async () => {
    const user = userEvent.setup();
    const requests: RecordedRequest[] = [];
    const { screen } = await startApplicationAt('/register', requests);

    await registerWith(user, screen, 'Bad Company');

    expect(await screen.findByText('auth.register.field.slugInvalid')).toBeInTheDocument();
    expect(requests).toEqual([]);
  });

  it('marks the slug field when the slug is taken, and raises no toast', async () => {
    const user = userEvent.setup();
    answer = () => problem('organization_already_exists', 409);
    const { screen } = await startApplicationAt('/register', []);

    await registerWith(user, screen);

    const message = await screen.findByText('errors.code.organization_already_exists');
    const slug = screen.getByLabelText(/auth\.register\.slug\.label/);
    expect(slug).toHaveAttribute('aria-invalid', 'true');
    expect(slug.getAttribute('aria-describedby')).toContain(message.id);
    expect(toasts().queryByText('errors.code.organization_already_exists')).not.toBeInTheDocument();
  });

  /**
   * The acceptance criterion «форма недоступна», in the only form an installation can deliver it:
   * nothing published before a session exists says whether registration is open — `GET /meta`
   * answers an API version and a clock — so the form is offered, and the 403 takes it away.
   */
  it('takes the form away when the installation is closed to registration', async () => {
    const user = userEvent.setup();
    answer = () => problem('registration_disabled', 403);
    const { screen } = await startApplicationAt('/register', []);

    await registerWith(user, screen);

    const notice = await screen.findByText('auth.register.closed.description');
    expect(notice.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'auth.register.submit' })).not.toBeInTheDocument();
    expect(toasts().queryByText('errors.code.registration_disabled')).not.toBeInTheDocument();
    // The way out survives the panel: this is a public screen, and one with no exit is a dead end.
    expect(screen.getByRole('link', { name: 'auth.register.backToLogin' })).toBeInTheDocument();
  });

  it('reports a refusal it cannot place above the fields, and keeps the form', async () => {
    const user = userEvent.setup();
    answer = () => problem('rate_limited', 429);
    const { screen } = await startApplicationAt('/register', []);

    await registerWith(user, screen);

    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('errors.code.rate_limited');
    expect(screen.getByRole('button', { name: 'auth.register.submit' })).toBeInTheDocument();
    expect(toasts().queryByText('errors.code.rate_limited')).not.toBeInTheDocument();
  });

  /**
   * Under a real catalogue, not `cimode` — and that is the whole point of the case.
   *
   * `cimode` answers `t(key)` with the key and drops the values, so a notice rendered as `t(key)`
   * and one rendered as `t(key, values)` are byte for byte the same on every other case in this
   * file. The fourth attempt an hour is where they differ: the server says how long to wait in
   * `Retry-After`, the client reads it, and the sentence has a place for it — and a form that
   * translated the key alone printed «Try again in {{seconds}} s.» to the one person who could not
   * be signed in to see anything else.
   */
  it('says how long to wait, with the number in the sentence', async () => {
    const user = userEvent.setup();
    answer = () => problem('rate_limited', 429, { 'retry-after': '42' });
    const { screen, container } = await startApplicationAt('/register', [], 'en');

    await registerByShape(user, container);

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('42');
    expect(notice.textContent).not.toContain('{{');
  });

  it('has no accessibility violation', async () => {
    const { container } = await startApplicationAt('/register', []);

    const { violations } = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
  });

  /**
   * The happy path is **last on purpose**, and the reason is a hazard this file shares with
   * `sign-in-flow.test.tsx`: a case that ends signed in leaves a live router listening to the one
   * browser history the whole file shares, and the next case mounts a second one beside it. Run
   * second, this case sent every later one to `/login` before its form was drawn — a failure with
   * nothing wrong in the code under test. Ordering is the fix that costs nothing; unmounting the
   * router is not something the tree offers.
   */
  it('sends the contract shape with an idempotency key, and ends up inside the application', async () => {
    const user = userEvent.setup();
    const requests: RecordedRequest[] = [];
    const { screen } = await startApplicationAt('/register', requests);

    await registerWith(user, screen);

    // The session is what carries the owner out of the public zone: the mutation records it, the
    // bus announces it, the router re-checks its guards and `redirectIfAuthed` does the rest. No
    // `navigate` is written anywhere on this screen.
    await waitFor(() => {
      expect(window.location.pathname).not.toBe('/register');
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.search).toBe('');
    expect(requests[0]?.idempotencyKey).toEqual(expect.any(String));
    expect(JSON.parse(requests[0]?.body ?? 'null')).toEqual({
      organization: { name: ORGANIZATION, slug: SLUG },
      owner: {
        email: EMAIL,
        password: PASSWORD,
        locale: expect.any(String),
        timezone: expect.any(String),
      },
    });
  });
});
