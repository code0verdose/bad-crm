import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type i18n as I18n } from 'i18next';

import { SharedI18n } from '@shared';

/**
 * `/admin/teams` — the org structure as a list.
 *
 * What only shows at this level:
 *
 *   * **the filter is the address bar.** `GET /teams` takes no parameters, so the phrase, the order
 *     and the page are applied to the answer — which makes «is the URL still the state» a question
 *     worth asking rather than one the network answers by accident. It has to land in the URL, reset
 *     the page, and survive being followed as a link;
 *   * **a team is not a group of access**, and the screen says so. Criterion 10 of STORY-012-07 is a
 *     sentence in the interface: without it an administrator who has just put five people on a team
 *     believes they have handed out five sets of permissions, and nothing else on this screen
 *     contradicts them;
 *   * **the create control is not offered to somebody who cannot create**, and the refusal is
 *     visible inside the dialog rather than behind it — a `aria-modal` dialog is the whole
 *     accessibility tree while it is open.
 */

const BACKEND = {
  id: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41',
  name: 'Backend',
  slug: 'backend',
  description: 'Служба платформы',
  memberCount: 7,
};

const DESIGN = {
  id: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a42',
  name: 'Design',
  slug: 'design',
  description: null,
  memberCount: 2,
};

let sent: { url: string; search: string; method: string; body: unknown }[];

const platformFetch = globalThis.fetch;

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** `application/problem+json` as the server produces it — `code` is the only field the UI reads. */
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

interface Answers {
  readonly granted?: readonly string[];
  readonly teams?: () => Response | Promise<Response>;
  readonly create?: () => Response;
  readonly path?: string;
  readonly i18n?: I18n;
  readonly language?: string;
}

const startAt = async ({
  granted = ['team:read', 'team:create'],
  teams = () => json({ items: [BACKEND, DESIGN] }),
  create = () => json(BACKEND, 201),
  path = '/admin/teams',
  i18n,
  language,
}: Answers = {}): Promise<ReturnType<typeof import('../support/render-app.util.js').renderApp>> => {
  vi.resetModules();
  vi.stubGlobal('fetch', async (input: Request) => {
    const parsed = new URL(input.url);
    const url = parsed.pathname;
    const body = input.method === 'POST' ? await input.clone().json() : undefined;

    sent.push({ url, search: parsed.search, method: input.method, body });

    if (url.endsWith('/me/permissions')) {
      return json({ permissions: [...granted], denied: [], roles: [], isOwner: false, version: 1 });
    }
    if (url.endsWith('/teams')) return input.method === 'POST' ? create() : await teams();

    return json({ status: 'ok' });
  });

  const { renderApp } = await import('../support/render-app.util.js');

  return renderApp({
    path,
    status: 'authenticated',
    ...(i18n === undefined ? {} : { i18n }),
    ...(language === undefined ? {} : { language }),
  });
};

const openCreateDialog = async (user: UserEvent): Promise<HTMLElement> => {
  await user.click(await screen.findByRole('button', { name: /teams\.create\.action/ }));

  return await screen.findByRole('dialog');
};

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('/admin/teams', () => {
  /**
   * The route guard, not the widget: `Route.beforeLoad` runs `requirePermission('team:read')`
   * before `AdminTeamsPage` is ever mounted. `src/app/routes/**` is excluded from the coverage
   * report (`vitest.config.ts` — the closing `});` of `createFileRoute` cannot be exercised by
   * anything short of navigation), so a `beforeLoad` deleted from the route file was invisible to
   * every metric while every case in this suite kept passing — each of them starts `startAt` with a
   * grant that includes `team:read`. `navigation.test.tsx` documents the same failure by hand; this
   * is the assertion against the actual route.
   */
  it('is not there at all for somebody who may not read teams', async () => {
    await startAt({ granted: [] });

    expect(await screen.findByText('errors.not_found.title')).toBeInTheDocument();
    // The guard runs in `beforeLoad`, before the loader: a request that reached the server here
    // would mean the screen rendered first and was refused per row, not kept off the page entirely.
    expect(sent.some((call) => call.url.endsWith('/teams'))).toBe(false);
  });
});

describe('the team list', () => {
  it('shows every live team with how many people are on it', async () => {
    await startAt();

    const table = await screen.findByRole('table');

    expect(within(table).getByText('Backend')).toBeInTheDocument();
    expect(within(table).getByText('backend')).toBeInTheDocument();
    expect(within(table).getByText('7')).toBeInTheDocument();
    expect(within(table).getByText('Design')).toBeInTheDocument();
  });

  /**
   * Criterion 10 of the story, and the reason it is a criterion: belonging to a team grants nothing
   * in this release, and every other affordance on this screen — «add somebody», «disband» — reads
   * exactly like the access management next door. The sentence is what stops an administrator
   * concluding they have delegated something.
   */
  it('says that a team grants nothing', async () => {
    await startAt();

    expect(await screen.findByText(/teams\.notAccessGroup\.title/)).toBeInTheDocument();
    expect(screen.getByText(/teams\.notAccessGroup\.description/)).toBeInTheDocument();
  });

  it('sends no filter to an endpoint that has none, however the URL is narrowed', async () => {
    // The phrase is applied to the answer, so it must not become a query parameter — and must not
    // become part of the cache address either, or every phrase somebody types keeps its own copy of
    // the same bytes.
    await startAt({ path: '/admin/teams?q=des&sort=-members&page=2' });

    await screen.findByRole('table');

    const reads = sent.filter((call) => call.url.endsWith('/teams') && call.method === 'GET');

    // CONTROL: the list was fetched at all, so «no parameters» is not «no request».
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.map((call) => call.search)).toEqual(reads.map(() => ''));
  });

  it('applies the phrase the URL carries to the answer', async () => {
    await startAt({ path: '/admin/teams?q=des' });

    const table = await screen.findByRole('table');

    expect(within(table).getByText('Design')).toBeInTheDocument();
    expect(within(table).queryByText('Backend')).toBeNull();
  });

  it('writes what was typed into the address bar, and resets the page', async () => {
    const user = userEvent.setup();

    const { router } = await startAt({ path: '/admin/teams?page=2' });

    await user.type(await screen.findByLabelText(/teams\.filters\.search/), 'des');

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ q: 'des' });
    });
    // Page one is the default, so it is not written out — what matters is that page two is gone.
    expect(router.state.location.search).toMatchObject({ page: 1 });
  });

  it('writes the order into the address bar, and resets the page too', async () => {
    const user = userEvent.setup();

    const { router } = await startAt({ path: '/admin/teams?page=2' });

    await user.selectOptions(await screen.findByLabelText(/teams\.filters\.sort/), '-members');

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ sort: '-members', page: 1 });
    });

    // And it is an order, not a filter: the biggest team is first now.
    const rows = within(await screen.findByRole('table')).getAllByRole('row');
    expect(within(rows[1] as HTMLElement).getByText('Backend')).toBeInTheDocument();
  });

  it('offers to widen a filter that matched nothing, not to create a first team', async () => {
    await startAt({ path: '/admin/teams?q=legal' });

    expect(await screen.findByText(/teams\.empty\.filtered/)).toBeInTheDocument();
  });

  it('offers to create the first team when there is genuinely nothing', async () => {
    await startAt({ teams: () => json({ items: [] }) });

    expect(await screen.findByText(/teams\.empty\.description/)).toBeInTheDocument();
  });

  it('says so, with a way back, when the list cannot be loaded', async () => {
    let recovers = false;

    await startAt({
      teams: () => (recovers ? json({ items: [BACKEND] }) : problem('team_forbidden', 403)),
    });

    await screen.findByTestId('error-state');

    // CONTROL: the retry is real, so the state is a failure of this request and not of the screen.
    recovers = true;
    await userEvent.setup().click(screen.getByRole('button', { name: 'common.retry' }));

    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  /**
   * The reset control is conditional on `filters.isFiltered`, and no case exercised the `false`
   * branch: every existing assertion about it starts from a URL that already carries `q`. A `&&`
   * turned unconditional renders a button with nothing to reset on the very first, unfiltered visit.
   */
  it('does not offer to reset a filter that was never applied', async () => {
    await startAt();

    await screen.findByRole('table');

    expect(screen.queryByRole('button', { name: /teams\.filters\.reset/ })).toBeNull();
  });

  it('offers to reset the filter once one is applied', async () => {
    await startAt({ path: '/admin/teams?q=des' });

    expect(
      await screen.findByRole('button', { name: /teams\.filters\.reset/ }),
    ).toBeInTheDocument();
  });
});

describe('creating a team', () => {
  it('is not offered to somebody who may only read them', async () => {
    await startAt({ granted: ['team:read'] });

    // The table is the proof that the permissions have arrived: without it the absence below would
    // equally be «the answer is still in flight», which is a different screen state.
    await screen.findByRole('table');

    expect(screen.queryByRole('button', { name: /teams\.create\.action/ })).toBeNull();
  });

  it('sends what was filled in and closes on success', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openCreateDialog(user));

    await user.type(dialog.getByLabelText(/teams\.field\.name/), 'Backend');
    await user.type(dialog.getByLabelText(/teams\.field\.slug/), 'backend');
    await user.type(dialog.getByLabelText(/teams\.field\.description/), 'Служба платформы');
    await user.click(dialog.getByRole('button', { name: /teams\.create\.submit/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(sent.find((call) => call.method === 'POST')?.body).toEqual({
      name: 'Backend',
      slug: 'backend',
      description: 'Служба платформы',
    });
  });

  /**
   * `description` is optional prose, and the contract treats a **missing** key and an empty string
   * differently: the field is `nullable`, and «cleared» has to be expressible. An empty input is
   * «nothing written», which is `null` — not `''`, which would store an empty paragraph.
   */
  it('sends no description as null rather than as an empty paragraph', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openCreateDialog(user));

    await user.type(dialog.getByLabelText(/teams\.field\.name/), 'Design');
    await user.type(dialog.getByLabelText(/teams\.field\.slug/), 'design');
    await user.click(dialog.getByRole('button', { name: /teams\.create\.submit/ }));

    await waitFor(() => {
      expect(sent.some((call) => call.method === 'POST')).toBe(true);
    });
    expect(sent.find((call) => call.method === 'POST')?.body).toMatchObject({ description: null });
  });

  /**
   * A malformed slug is a **field** error, not a toast: the person has to know which of three inputs
   * to fix, and a sentence in the corner of the screen does not say (`rules/errors-and-toasts.mdc`
   * §4). It is also caught before the request, by the same shape the endpoint publishes.
   */
  it('refuses a slug the contract would refuse, at the field, without asking the server', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openCreateDialog(user));

    await user.type(dialog.getByLabelText(/teams\.field\.name/), 'Backend');
    await user.type(dialog.getByLabelText(/teams\.field\.slug/), 'Backend Team');
    await user.click(dialog.getByRole('button', { name: /teams\.create\.submit/ }));

    expect(await dialog.findByText(/teams\.field\.slugInvalid/)).toBeInTheDocument();
    expect(sent.some((call) => call.method === 'POST')).toBe(false);
  });

  it('refuses an empty name at the field', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openCreateDialog(user));

    await user.type(dialog.getByLabelText(/teams\.field\.slug/), 'backend');
    await user.click(dialog.getByRole('button', { name: /teams\.create\.submit/ }));

    expect(await dialog.findByText(/validation\.required/)).toBeInTheDocument();
    expect(sent.some((call) => call.method === 'POST')).toBe(false);
  });

  /**
   * The same rule as the case above, for the field the schema was not actually enforcing:
   * `teamFormSchema` carried `.min(1)` on `slug`, but nothing sent an empty one through the form to
   * notice if it were removed — unlike `name`, whose empty case is the test right above this one.
   * Without it, the dialog would submit `slug: ''` and the server would refuse it with a `422`
   * (`test/integration/http/team-endpoints.test.ts:131`) the person never sees explained at the field.
   */
  it('refuses an empty slug at the field', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openCreateDialog(user));

    await user.type(dialog.getByLabelText(/teams\.field\.name/), 'Backend');
    await user.click(dialog.getByRole('button', { name: /teams\.create\.submit/ }));

    expect(await dialog.findByText(/validation\.required/)).toBeInTheDocument();
    expect(sent.some((call) => call.method === 'POST')).toBe(false);
  });

  /**
   * A taken slug is the refusal this endpoint really produces, and it has to be readable from inside
   * the dialog: while a `aria-modal` dialog is open, nothing outside it is in the accessibility tree
   * a screen reader is confined to. The mutation therefore declares its own `onError` so the global
   * toast stands aside — one action, one signal (`rules/errors-and-toasts.mdc` §2–§3).
   */
  it('shows a refusal inside the dialog, exactly once', async () => {
    const user = userEvent.setup();

    await startAt({ create: () => problem('team_already_exists', 409) });

    const dialog = await openCreateDialog(user);
    const scope = within(dialog);

    await user.type(scope.getByLabelText(/teams\.field\.name/), 'Backend');
    await user.type(scope.getByLabelText(/teams\.field\.slug/), 'backend');
    await user.click(scope.getByRole('button', { name: /teams\.create\.submit/ }));

    expect(await scope.findByText(/teams\.create\.failed/)).toBeInTheDocument();
    expect(screen.getAllByText(/errors\.code\.team_already_exists/)).toHaveLength(1);
    // The dialog stays, filled in: a refusal is not a reason to make somebody retype the form.
    expect(scope.getByLabelText(/teams\.field\.slug/)).toHaveValue('backend');
  });

  it('forgets what was typed when the dialog is closed and reopened', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openCreateDialog(user));

    await user.type(dialog.getByLabelText(/teams\.field\.name/), 'Backend');
    await user.click(dialog.getByRole('button', { name: /teams\.create\.close/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    expect(within(await openCreateDialog(user)).getByLabelText(/teams\.field\.name/)).toHaveValue(
      '',
    );
  });

  it('returns focus to the control that opened it', async () => {
    const user = userEvent.setup();

    await startAt();

    const trigger = await screen.findByRole('button', { name: /teams\.create\.action/ });

    await user.click(trigger);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: /teams\.create\.close/,
      }),
    );

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });
});

/**
 * axe over the states this screen actually has, not over whichever one a case happened to leave
 * behind. The dialog replaces the accessibility tree while it is open, and the empty state is a
 * different subtree from the table — scanning one and claiming the screen is how the other ships
 * with a violation.
 */
describe.each([
  ['with the table on screen', async () => await screen.findByRole('main'), false],
  [
    'with the create dialog open',
    async () => {
      await openCreateDialog(userEvent.setup());

      return await screen.findByRole('dialog');
    },
    true,
  ],
] as const)('the team list has no accessibility violation %s', (_case, reach, isModal) => {
  it('passes axe', async () => {
    await startAt();

    await screen.findByRole('table');

    const region = await reach();

    const { violations, passes } = await axe.run(region, {
      rules: {
        // Disabled because jsdom cannot answer it, not because the answer is inconvenient — and the
        // premise is checked below rather than claimed. jsdom performs no layout, so every node the
        // rule looks at is judged `hidden` and no pair of colours is ever compared. Contrast is
        // checked where it can be: `test/theme/tokens.test.ts` over every token pair in both
        // schemes, and `@axe-core/playwright` against a real engine in e2e.
        'color-contrast': { enabled: false },
        /**
         * Off **only** for the modal case, and the premise is asserted rather than claimed.
         *
         * The rule is a document-level heuristic — «two banner landmarks on one page» — and it does
         * not model `aria-modal`. While this dialog is open the shell behind it is inert for
         * assistive technology, so its header is not a second banner in any sense a reader
         * experiences. Left on for the table case, where the same finding would be real.
         */
        ...(isModal ? { 'landmark-no-duplicate-banner': { enabled: false } } : {}),
      },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
    // CONTROL: the scan looked at this subtree rather than at nothing.
    expect(passes.map((rule) => rule.id).length).toBeGreaterThan(0);

    // The premise of the landmark exemption, stated for both cases rather than only where it is
    // used: the exemption is sound exactly because this subtree is the modal, and the other case
    // proves the attribute is not simply always there.
    expect(region.getAttribute('aria-modal')).toBe(isModal ? 'true' : null);

    // The premise of the exemption: switched on, the rule measures nothing — every outcome it
    // reports is `hidden`, axe's word for «this node has no box», which without layout is every node.
    const withContrast = await axe.run(region, { runOnly: ['color-contrast'] });
    const measured = withContrast.passes
      .flatMap((rule) =>
        rule.nodes.flatMap((node) =>
          node.any.map((check) => (check.data as { messageKey?: string } | null)?.messageKey),
        ),
      )
      .filter((outcome) => outcome !== 'hidden');

    expect(withContrast.violations).toEqual([]);
    expect(measured).toEqual([]);
  });
});

/**
 * The one property `cimode` cannot state.
 *
 * Every assertion above matches a **key**, which is what makes them readable and what makes them
 * blind: `teams.notAccessGroup.description` matches whether the sentence explains that membership
 * grants nothing, says the opposite, or is an empty string somebody added to satisfy the parity
 * gate. Criterion 10 is about what an administrator can read, so both catalogues are rendered for
 * real and the sentence is asserted as a sentence.
 */
describe.each(['en', 'ru'] as const)('the «not an access group» notice in %s', (language) => {
  it('is a sentence, in this language, with nothing left un-interpolated', async () => {
    const i18n = SharedI18n.createI18n(language);

    await startAt({ i18n, language });

    const notice = await screen.findByText(i18n.t('teams.notAccessGroup.description'));

    expect(notice).toBeInTheDocument();
    expect(notice.textContent ?? '').not.toBe('');
    expect(notice.textContent ?? '').not.toMatch(/\{\{/);
    // Named through the catalogue rather than through the key: in a real language the heading reads
    // «Teams» / «Команды», and a regex over the key would find nothing here.
    expect(
      screen.getByRole('heading', { level: 1, name: i18n.t('teams.title') }),
    ).toBeInTheDocument();
  });
});
