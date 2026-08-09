import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type i18n as I18n } from 'i18next';

import { SharedI18n, SharedLib } from '@shared';

/**
 * `/admin/teams/$teamId` — who is on a team, and the three things one can do about it.
 *
 * The properties that only exist at this level:
 *
 *   * **the roster carries user ids and no names.** `GET /teams/{teamId}` answers that way on
 *     purpose — names are `user:read`, and attaching a second permission's worth of personal data to
 *     a read that asked which accounts are on a team would be the wrong trade. So the screen joins
 *     the directory when it may, and says the id when it may not. Both halves are asserted, because
 *     the fallback is the one that only appears for a caller nobody tests as;
 *   * **a control that cannot work is not drawn.** «Add somebody» needs a list of people to choose
 *     from; without `user:read` there is no list, so there is no control — not a disabled one, and
 *     not one that opens an empty picker (the reasoning of `pages/employee-profile/page.tsx`);
 *   * **disbanding is confirmed, and the confirmation says what it costs** *before* the button:
 *     every membership goes, and the decision has to be makeable from the dialog rather than from
 *     the aftermath;
 *   * **a refusal is visible where the action was started.** Inside the dialog it is rendered in
 *     place — a `aria-modal` dialog is the whole accessibility tree while it is open; outside it,
 *     the one global toast is the signal.
 */

const TEAM = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a41';
const IVAN = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a51';
const OLGA = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a52';
/** On the team, and not in the directory answer — the row that has to fall back to the id. */
const GHOST = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a53';

const DETAIL = {
  id: TEAM,
  name: 'Backend',
  slug: 'backend',
  description: 'Служба платформы',
  memberCount: 2,
  members: [
    { userId: IVAN, teamRole: 'LEAD', joinedAt: '2026-01-05T10:00:00.000Z' },
    { userId: GHOST, teamRole: 'MEMBER', joinedAt: '2026-02-05T10:00:00.000Z' },
  ],
};

const person = (userId: string, lastName: string) => ({
  userId,
  email: `${lastName.toLowerCase()}@example.test`,
  firstName: 'Ivan',
  lastName,
  jobTitle: 'Backend engineer',
  department: 'Platform',
  status: 'ACTIVE',
  managerId: null,
  roles: [],
  teams: [],
});

let sent: { url: string; method: string; body: unknown }[];

const platformFetch = globalThis.fetch;

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const noContent = (): Response => new Response(null, { status: 204 });

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
  readonly detail?: () => Response;
  readonly write?: () => Response | Promise<Response>;
  /** What `GET /employees` answers with — the people this screen joins the roster against. */
  readonly people?: readonly ReturnType<typeof person>[];
  readonly i18n?: I18n;
  readonly language?: string;
}

const startAt = async ({
  granted = ['team:read', 'team:update', 'team:delete', 'team:manage_members', 'user:read'],
  detail = () => json(DETAIL),
  write = () => noContent(),
  people = [person(IVAN, 'Petrov'), person(OLGA, 'Sidorova')],
  i18n,
  language,
}: Answers = {}): Promise<ReturnType<typeof import('../support/render-app.util.js').renderApp>> => {
  vi.resetModules();
  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url).pathname;
    const body =
      input.method === 'POST' || input.method === 'PATCH' ? await input.clone().json() : undefined;

    sent.push({ url, method: input.method, body });

    if (url.endsWith('/me/permissions')) {
      return json({ permissions: [...granted], denied: [], roles: [], isOwner: false, version: 1 });
    }
    if (url.endsWith('/employees')) {
      return json({
        items: [...people],
        total: people.length,
        page: 1,
        perPage: 100,
        sort: 'name',
        facets: { roles: [], teams: [] },
      });
    }
    if (url.endsWith(`/teams/${TEAM}`)) return input.method === 'GET' ? detail() : await write();
    if (url.includes(`/teams/${TEAM}/members`)) return await write();

    return json({ status: 'ok' });
  });

  const { renderApp } = await import('../support/render-app.util.js');

  return renderApp({
    path: `/admin/teams/${TEAM}`,
    status: 'authenticated',
    ...(i18n === undefined ? {} : { i18n }),
    ...(language === undefined ? {} : { language }),
  });
};

const roster = async (): Promise<HTMLElement> => await screen.findByRole('table');

const openDeleteDialog = async (user: UserEvent): Promise<HTMLElement> => {
  await user.click(await screen.findByRole('button', { name: /teams\.delete\.action/ }));

  return await screen.findByRole('dialog');
};

const employeeCalls = (): typeof sent => sent.filter((call) => call.url.endsWith('/employees'));

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('/admin/teams/$teamId', () => {
  /**
   * The route guard: `Route.beforeLoad` runs `requirePermission('team:read')` before
   * `TeamDetailPage` mounts. `src/app/routes/**` sits outside the coverage report, so a deleted
   * `beforeLoad` here is invisible to every metric while every other case in this suite passes —
   * each of them grants `team:read` in `startAt`'s default. Without this guard actually attached,
   * every «is not offered to somebody who may not …» assertion in this file loses its premise: the
   * table being drawn at all is what makes the button's absence mean «no permission» rather than
   * «still loading» (`team-list.test.tsx:235`, `team-detail.test.tsx` throughout).
   */
  it('is not there at all for somebody who may not read teams', async () => {
    await startAt({ granted: [] });

    expect(await screen.findByText('errors.not_found.title')).toBeInTheDocument();
    expect(sent.some((call) => call.url.endsWith(`/teams/${TEAM}`))).toBe(false);
  });
});

describe('the team', () => {
  it('shows what the team is', async () => {
    await startAt();

    expect(await screen.findByRole('heading', { level: 2, name: 'Backend' })).toBeInTheDocument();
    expect(screen.getByText('backend')).toBeInTheDocument();
    // By element, because the rename form below holds the same prose in a textarea: the paragraph is
    // the one a reader who may not rename anything still sees.
    expect(screen.getByText('Служба платформы', { selector: 'p' })).toBeInTheDocument();
  });

  /** Criterion 10, on the screen where somebody is about to add five people to a team. */
  it('says that membership grants nothing', async () => {
    await startAt();

    expect(await screen.findByText(/teams\.notAccessGroup\.description/)).toBeInTheDocument();
  });

  /**
   * A team with nothing written about it, which is the ordinary one: `description` is optional prose
   * and `PATCH` **replaces**, so the rename form has to start from «nothing written» rather than from
   * the word `null` — and the page above it must not print an empty paragraph where the prose is not.
   */
  it('shows no description when there is none, and offers an empty field for one', async () => {
    await startAt({ detail: () => json({ ...DETAIL, description: null }) });

    await roster();

    expect(screen.queryByText('Служба платформы')).toBeNull();
    expect(screen.getByLabelText(/teams\.field\.description/)).toHaveValue('');
  });

  it('says so, with a way back, when the team cannot be loaded', async () => {
    let recovers = false;

    await startAt({ detail: () => (recovers ? json(DETAIL) : problem('team_not_found', 404)) });

    await screen.findByTestId('error-state');

    recovers = true;
    await userEvent.setup().click(screen.getByRole('button', { name: 'common.retry' }));

    expect(await roster()).toBeInTheDocument();
  });
});

describe('the roster', () => {
  it('names the people it can, and marks who leads', async () => {
    await startAt();

    const rows = within(await roster()).getAllByRole('row');

    expect(within(rows[1] as HTMLElement).getByText(/Petrov/)).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText(/teams\.role\.LEAD/)).toBeInTheDocument();
  });

  /**
   * The row for somebody the directory did not answer with — a person outside the first page of it,
   * or a caller whose directory answer is narrower than the roster. An empty cell would read as a
   * membership that lost its owner; the id is what the contract actually gives, so it is what is
   * shown.
   */
  it('falls back to the account id for a person it cannot name', async () => {
    await startAt();

    expect(within(await roster()).getByText(GHOST)).toBeInTheDocument();
  });

  it('does not ask for the directory at all without the permission to read it', async () => {
    await startAt({ granted: ['team:read', 'team:manage_members'] });

    await roster();

    // A request that is certain to be refused is not a fallback, it is a 403 per page view.
    expect(employeeCalls()).toEqual([]);
    expect(within(await roster()).getByText(IVAN)).toBeInTheDocument();
  });

  /**
   * The «joined» column formats the timestamp for the reader instead of printing the wire value.
   *
   * The expected string is computed through the same `SharedLib.formatDate` call the component
   * makes, rather than pinned as a literal — the property under test is «this column goes through
   * the formatter», not a specific rendering in one timezone, and a literal would make the case
   * depend on the machine it runs on. What still makes this a real assertion is the second line: the
   * raw ISO string the table cell would show instead is asserted absent, so a component that started
   * interpolating the timestamp directly cannot pass by coincidence.
   */
  it('formats the join date for the reader instead of the raw timestamp', async () => {
    await startAt();

    const rows = within(await roster()).getAllByRole('row');
    const ivanRow = within(rows[1] as HTMLElement);
    const expected = SharedLib.formatDate(
      DETAIL.members[0]?.joinedAt as string,
      'cimode',
      SharedLib.resolveTimeZone(),
    );

    expect(ivanRow.getByText(expected)).toBeInTheDocument();
    expect(ivanRow.queryByText(DETAIL.members[0]?.joinedAt as string)).toBeNull();
  });
});

describe('putting somebody on the team', () => {
  it('is not offered to somebody who may not manage the composition', async () => {
    await startAt({ granted: ['team:read', 'user:read'] });

    // The roster is the proof that the permissions have arrived — without it the absence below is
    // equally «still loading», which is a different screen state.
    await roster();

    expect(screen.queryByLabelText(/teams\.members\.add\.person/)).toBeNull();
  });

  /**
   * The control needs a list of people to choose from, and that list is `user:read`. Somebody with
   * `team:manage_members` and without it holds a permission they cannot exercise **on this screen**,
   * and a picker over an empty list is a control that opens and offers nothing.
   */
  it('is not offered when there is no directory to choose from', async () => {
    await startAt({ granted: ['team:read', 'team:manage_members'] });

    await roster();

    expect(screen.queryByLabelText(/teams\.members\.add\.person/)).toBeNull();
  });

  /**
   * The picker starts on a placeholder and the button starts unusable.
   *
   * The alternative — pre-selecting whoever happens to be first alphabetically — is a form that is
   * armed on arrival, on a screen where the arming adds a colleague to a team.
   */
  it('will not add anybody until somebody is chosen', async () => {
    const user = userEvent.setup();

    await startAt();

    const submit = await screen.findByRole('button', { name: /teams\.members\.add\.submit/ });

    expect(submit).toBeDisabled();

    await user.selectOptions(screen.getByLabelText(/teams\.members\.add\.person/), OLGA);

    expect(submit).toBeEnabled();
  });

  /**
   * A picker holding only its own placeholder is a control that opens and offers nothing — the same
   * defect as a button that always answers 403, one interaction further in. So it becomes a sentence.
   */
  it('says so instead, when everybody in the directory is already on the team', async () => {
    await startAt({ people: [person(IVAN, 'Petrov')] });

    expect(await screen.findByText(/teams\.members\.add\.none/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/teams\.members\.add\.person/)).toBeNull();
  });

  /**
   * A personnel record nobody has filled in carries empty names — the repository answers with an
   * empty row when there is no `EmployeeProfile`, and neither registration nor accepting an
   * invitation creates one, so this is the ordinary record rather than an edge case. An option with
   * no text is an option nobody can choose on purpose.
   */
  it('labels somebody with no name by their address', async () => {
    await startAt({
      people: [{ ...person(OLGA, 'Sidorova'), firstName: '', lastName: '' }],
    });

    const picker = await screen.findByLabelText(/teams\.members\.add\.person/);

    expect(
      within(picker).getByRole('option', { name: 'sidorova@example.test' }),
    ).toBeInTheDocument();
  });

  it('sends the account and the role it was given', async () => {
    const user = userEvent.setup();

    await startAt();

    await user.selectOptions(await screen.findByLabelText(/teams\.members\.add\.person/), OLGA);
    await user.selectOptions(screen.getByLabelText(/teams\.members\.add\.role/), 'LEAD');
    await user.click(screen.getByRole('button', { name: /teams\.members\.add\.submit/ }));

    await waitFor(() => {
      expect(sent.some((call) => call.method === 'POST')).toBe(true);
    });
    expect(sent.find((call) => call.method === 'POST')).toMatchObject({
      url: `/api/v1/teams/${TEAM}/members`,
      body: { userId: OLGA, teamRole: 'LEAD' },
    });
  });

  /** Somebody already on the team is not an option: adding them again is a request with no meaning. */
  it('offers only people who are not on the team yet', async () => {
    await startAt();

    const picker = await screen.findByLabelText(/teams\.members\.add\.person/);

    expect(within(picker).getByRole('option', { name: /Sidorova/ })).toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: /Petrov/ })).toBeNull();
  });

  /**
   * The race the endpoint is explicit about: a person deactivated between the page load and the
   * click. The refusal is a toast because this control is on the page rather than in a modal — and
   * exactly one, from the global handler.
   */
  it('reports a deactivated account, once', async () => {
    const user = userEvent.setup();

    await startAt({ write: () => problem('member_not_active', 409) });

    await user.selectOptions(await screen.findByLabelText(/teams\.members\.add\.person/), OLGA);
    await user.click(screen.getByRole('button', { name: /teams\.members\.add\.submit/ }));

    expect(await screen.findByText(/errors\.code\.member_not_active/)).toBeInTheDocument();
    expect(screen.getAllByText(/errors\.code\.member_not_active/)).toHaveLength(1);
  });
});

describe('taking somebody off the team', () => {
  it('is not offered to somebody who may not manage the composition', async () => {
    await startAt({ granted: ['team:read', 'user:read'] });

    await roster();

    expect(screen.queryByRole('button', { name: /teams\.members\.remove/ })).toBeNull();
  });

  /**
   * One control per row, and each is asserted from its own row rather than by name: in `cimode`
   * every label reads `teams.members.remove`, interpolation and all. That the label actually **names
   * the person** is a statement about a catalogue, so it is made in a real language further down —
   * this case is about the request the control on Ivan's row sends.
   */
  /**
   * The wait lives on the control that was pressed, not on the page.
   *
   * `rules/errors-and-toasts.mdc` §7: an action started from a button reports its progress there, so
   * the rest of the roster stays readable — a global spinner over a table somebody is reading is a
   * screen that goes blank because one row is being changed. And it is the pressed row's control,
   * which is why the mutation's own `variables` decide rather than a shared boolean.
   */
  it('shows the wait on the row it was started from', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });

    await startAt({
      write: async () => {
        await inFlight;

        return noContent();
      },
    });

    const rows = within(await roster()).getAllByRole('row');
    const removeIvan = within(rows[1] as HTMLElement).getByRole('button', {
      name: /teams\.members\.remove/,
    });
    const removeGhost = within(rows[2] as HTMLElement).getByRole('button', {
      name: /teams\.members\.remove/,
    });

    await user.click(removeIvan);

    await waitFor(() => {
      expect(removeIvan).toHaveAttribute('data-loading', 'true');
    });
    // CONTROL: the other row is not waiting for somebody else's request.
    expect(removeGhost).not.toHaveAttribute('data-loading', 'true');

    release();

    await waitFor(() => {
      expect(removeIvan).not.toHaveAttribute('data-loading', 'true');
    });
  });

  it('sends the removal for that membership', async () => {
    const user = userEvent.setup();

    await startAt();

    const rows = within(await roster()).getAllByRole('row');

    await user.click(
      within(rows[1] as HTMLElement).getByRole('button', { name: /teams\.members\.remove/ }),
    );

    await waitFor(() => {
      expect(sent.some((call) => call.method === 'DELETE')).toBe(true);
    });
    expect(sent.find((call) => call.method === 'DELETE')?.url).toBe(
      `/api/v1/teams/${TEAM}/members/${IVAN}`,
    );
  });
});

describe('renaming the team', () => {
  it('is not offered to somebody who may not update it', async () => {
    await startAt({ granted: ['team:read', 'user:read'] });

    await roster();

    expect(screen.queryByRole('button', { name: /teams\.edit\.submit/ })).toBeNull();
  });

  /**
   * `PATCH /teams/{teamId}` is **replace, not merge**: the body is what the team will be, and a
   * description left out is cleared. So the form is filled from the answer and sends all three
   * fields — sending only what changed would silently erase the prose nobody touched.
   */
  it('sends the whole team, not the difference', async () => {
    const user = userEvent.setup();

    await startAt();

    const name = await screen.findByLabelText(/teams\.field\.name/);

    await user.clear(name);
    await user.type(name, 'Platform');
    await user.click(screen.getByRole('button', { name: /teams\.edit\.submit/ }));

    await waitFor(() => {
      expect(sent.some((call) => call.method === 'PATCH')).toBe(true);
    });
    expect(sent.find((call) => call.method === 'PATCH')?.body).toEqual({
      name: 'Platform',
      slug: 'backend',
      description: 'Служба платформы',
    });
  });

  it('clears the description when it is emptied, rather than leaving it as it was', async () => {
    const user = userEvent.setup();

    await startAt();

    await user.clear(await screen.findByLabelText(/teams\.field\.description/));
    await user.click(screen.getByRole('button', { name: /teams\.edit\.submit/ }));

    await waitFor(() => {
      expect(sent.some((call) => call.method === 'PATCH')).toBe(true);
    });
    expect(sent.find((call) => call.method === 'PATCH')?.body).toMatchObject({ description: null });
  });

  /**
   * The rename form has no dialog around it — it lives on the page — so `useUpdateTeam` declares no
   * local `onError` and lets the global `MutationCache.onError` raise the one toast
   * (`rules/errors-and-toasts.mdc` §3). `createTeam` and `deleteTeam` both have a local `onError` for
   * the same code (`team_already_exists`, `team_forbidden`) because *they* are dialogs; this is the
   * mutation that is deliberately the other shape, and until now nothing asserted the toast actually
   * appears — the addTeamMember case right below (`reports a deactivated account, once`) is the only
   * precedent for a global toast in this file.
   */
  it('reports a slug conflict with the global toast', async () => {
    const user = userEvent.setup();

    await startAt({ write: () => problem('team_already_exists', 409) });

    const name = await screen.findByLabelText(/teams\.field\.name/);

    await user.clear(name);
    await user.type(name, 'Platform');
    await user.click(screen.getByRole('button', { name: /teams\.edit\.submit/ }));

    expect(await screen.findByText(/errors\.code\.team_already_exists/)).toBeInTheDocument();
    expect(screen.getAllByText(/errors\.code\.team_already_exists/)).toHaveLength(1);
  });
});

describe('disbanding the team', () => {
  it('is not offered to somebody who may not delete it', async () => {
    await startAt({ granted: ['team:read', 'user:read'] });

    await roster();

    expect(screen.queryByRole('button', { name: /teams\.delete\.action/ })).toBeNull();
  });

  /**
   * The consequences come **before** the button, in reading order and in the DOM — a keyboard or
   * screen-reader user reaches the control after the sentence that explains it, not before.
   */
  it('lists what it costs above the button that does it', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDeleteDialog(user);
    const consequence = within(dialog).getByText(/teams\.delete\.consequence\.members/);
    const confirm = within(dialog).getByRole('button', { name: /teams\.delete\.submit/ });

    expect(within(dialog).getByText(/teams\.delete\.consequence\.slug/)).toBeInTheDocument();
    expect(
      consequence.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('has a close control a screen reader can name', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDeleteDialog(user);

    expect(
      within(dialog).getAllByRole('button', { name: /teams\.delete\.cancel/ }).length,
    ).toBeGreaterThan(0);
  });

  it('traps focus inside the dialog', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDeleteDialog(user);

    for (let step = 0; step < 10; step += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('returns focus to the trigger when it closes', async () => {
    const user = userEvent.setup();

    await startAt();

    const trigger = await screen.findByRole('button', { name: /teams\.delete\.action/ });

    await user.click(trigger);
    await user.click(
      within(await screen.findByRole('dialog')).getAllByRole('button', {
        name: /teams\.delete\.cancel/,
      })[0] as HTMLElement,
    );

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it('sends the disbanding and leaves for the list', async () => {
    const user = userEvent.setup();

    const { router } = await startAt();

    const dialog = await openDeleteDialog(user);

    await user.click(within(dialog).getByRole('button', { name: /teams\.delete\.submit/ }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/admin/teams');
    });
    expect(
      sent.find((call) => call.method === 'DELETE' && call.url === `/api/v1/teams/${TEAM}`),
    ).toBeDefined();
  });

  /**
   * A refusal has to be readable from inside the dialog: while it is open, nothing outside it is in
   * the accessibility tree a screen reader is confined to. The mutation declares its own `onError`
   * so the global toast stands aside — one action, one signal.
   */
  it('shows a refusal inside the dialog, exactly once', async () => {
    const user = userEvent.setup();

    await startAt({ write: () => problem('team_forbidden', 403) });

    const dialog = await openDeleteDialog(user);

    await user.click(within(dialog).getByRole('button', { name: /teams\.delete\.submit/ }));

    expect(await within(dialog).findByText(/teams\.delete\.failed/)).toBeInTheDocument();
    expect(screen.getAllByText(/errors\.code\.team_forbidden/)).toHaveLength(1);
    // Still on the team: leaving for the list would claim the disbanding happened.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe.each([
  ['with the team on screen', async () => await screen.findByRole('main'), false],
  [
    'with the disband dialog open',
    async () => {
      await openDeleteDialog(userEvent.setup());

      return await screen.findByRole('dialog');
    },
    true,
  ],
] as const)('the team screen has no accessibility violation %s', (_case, reach, isModal) => {
  it('passes axe', async () => {
    await startAt();

    await roster();

    const region = await reach();

    const { violations, passes } = await axe.run(region, {
      rules: {
        // jsdom performs no layout, so this rule judges every node `hidden` and compares no colours
        // at all — the premise is checked below rather than claimed. Contrast is measured where it
        // can be: `test/theme/tokens.test.ts` over both schemes, and `@axe-core/playwright` in e2e.
        'color-contrast': { enabled: false },
        /**
         * Off **only** for the modal case, and the premise is asserted rather than claimed. The rule
         * is a document-level heuristic — «two banner landmarks on one page» — and it does not model
         * `aria-modal`: while this dialog is open the shell behind it is inert for assistive
         * technology, so its header is not a second banner in any sense a reader experiences.
         */
        ...(isModal ? { 'landmark-no-duplicate-banner': { enabled: false } } : {}),
      },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
    expect(passes.map((rule) => rule.id).length).toBeGreaterThan(0);

    // The premise of the landmark exemption, stated for both cases rather than only where it is
    // used: the exemption is sound exactly because this subtree is the modal, and the other case
    // proves the attribute is not simply always there.
    expect(region.getAttribute('aria-modal')).toBe(isModal ? 'true' : null);

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
 * The two sentences `cimode` cannot state.
 *
 * Every assertion above matches a **key**, which is what makes them readable and what makes them
 * blind: `teams.members.remove` matches whether the label names the person, names nobody, or renders
 * `{{person}}` because the interpolation variable was renamed on one side. Both are labels whose
 * whole job is to say *which* — which colleague this control removes, which team is about to stop
 * existing — so both catalogues are rendered for real and the value is asserted as a value.
 */
describe.each(['en', 'ru'] as const)('the interpolated labels in %s', (language) => {
  it('name the person a remove control would remove', async () => {
    const i18n = SharedI18n.createI18n(language);

    await startAt({ i18n, language });

    const rows = within(await roster()).getAllByRole('row');
    const remove = within(rows[1] as HTMLElement).getByRole('button', { name: /Ivan Petrov/ });

    // Nothing left un-interpolated: a placeholder in a label is a key renamed on one side only.
    expect(remove.getAttribute('aria-label') ?? '').not.toMatch(/\{\{/);
  });

  it('name the team the disband dialog is about', async () => {
    const i18n = SharedI18n.createI18n(language);

    await startAt({ i18n, language });

    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: i18n.t('teams.delete.action') }));

    const dialog = within(await screen.findByRole('dialog'));

    expect(dialog.getByText(/Backend/)).toBeInTheDocument();
    expect(dialog.queryByText(/\{\{/)).toBeNull();
  });
});
