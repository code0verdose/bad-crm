import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';

import i18next, { type i18n as I18n } from 'i18next';

import { SharedI18n } from '@shared';

import { axeViolationsIn } from '../support/axe-scan.util.js';

/**
 * `/projects` — the list of projects (STORY-014-04, client half).
 *
 * Mounted as the whole application — real guard, real router, real query client — because what this
 * screen can get wrong is a round trip: a filter has to land in the address bar, reset the page and
 * go out as a request with the same parameters; a stale request has to be cancelled; a page turn
 * must not blink. None of that is visible from inside one component.
 *
 * What the list **contains** — the private projects a reader is not on, the absence of financial
 * fields — is decided and asserted on the server (`project-list.test.ts`,
 * `project-list-endpoints.test.ts`); a client test over a fixture that never carried a hidden
 * project could not fail.
 */

const LEAD = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b11';
const OTHER_LEAD = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b12';
const ALL_RIGHTS = ['project:read', 'project:create', 'user:read'];

interface Call {
  readonly url: string;
  readonly search: URLSearchParams;
  readonly signal: AbortSignal;
}

let sent: Call[];

const platformFetch = globalThis.fetch;

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const project = (index: number, overrides: Record<string, unknown> = {}) => ({
  id: `018f4a3b-2c1d-7a41-9f00-${String(index).padStart(12, '0')}`,
  key: `BAD${String(index)}`,
  name: `Project ${String(index)}`,
  status: 'ACTIVE',
  visibility: 'PUBLIC_ORG',
  leadId: LEAD,
  color: 'brand',
  memberCount: 3,
  ...overrides,
});

const pageOf = (items: unknown[], total = items.length) => ({
  items,
  total,
  page: 1,
  perPage: 25,
  sort: 'name',
  facets: { statuses: ['ACTIVE', 'ON_HOLD'], leadIds: [LEAD, OTHER_LEAD] },
});

interface ServerOptions {
  readonly granted?: readonly string[];
  /** The answer to `GET /projects`, per call — `search` is what the client asked for. */
  readonly list?: (search: URLSearchParams, signal: AbortSignal) => Response | Promise<Response>;
}

const stubServer = ({
  granted = ALL_RIGHTS,
  list = () => json(pageOf([project(1)])),
}: ServerOptions): void => {
  const log: Call[] = [];

  sent = log;

  vi.stubGlobal('fetch', (input: Request) => {
    const url = new URL(input.url);

    log.push({ url: url.pathname, search: url.searchParams, signal: input.signal });

    if (url.pathname.endsWith('/me/permissions')) {
      return Promise.resolve(
        json({ permissions: granted, denied: [], roles: [], isOwner: false, version: 1 }),
      );
    }
    if (url.pathname.endsWith('/projects')) {
      return Promise.resolve(list(url.searchParams, input.signal));
    }
    if (url.pathname.endsWith('/employees')) {
      return Promise.resolve(
        json({
          items: [
            {
              userId: LEAD,
              email: 'anna@example.test',
              firstName: 'Anna',
              lastName: 'Ivanova',
              jobTitle: null,
              department: null,
              status: 'ACTIVE',
              managerId: null,
              roles: [],
              teams: [],
            },
          ],
          total: 1,
          page: 1,
          perPage: 100,
          sort: 'name',
          facets: { roles: [], teams: [] },
        }),
      );
    }

    return Promise.resolve(json({ status: 'ok' }));
  });
};

interface MountOptions extends ServerOptions {
  readonly path?: string;
  readonly i18n?: I18n;
  readonly language?: string;
}

const startAt = async ({ path = '/projects', i18n, language, ...options }: MountOptions = {}) => {
  vi.resetModules();
  stubServer(options);

  const { renderApp } = await import('../support/render-app.util.js');

  return renderApp({
    path,
    status: 'authenticated',
    ...(i18n === undefined ? {} : { i18n }),
    ...(language === undefined ? {} : { language }),
  });
};

const listCalls = (): Call[] => sent.filter((call) => call.url.endsWith('/projects'));

/**
 * An answer that arrives only when the test says so — or never, if the request is cancelled.
 *
 * Each caller gets **its own** `Response`: a body can be read once, and under `StrictMode` the same
 * question may be asked twice.
 */
const deferred = () => {
  let release: (payload: unknown) => void = () => undefined;
  const gate = new Promise<unknown>((settle) => {
    release = settle;
  });

  return {
    answer: (): Promise<Response> => gate.then((payload) => json(payload)),
    resolve: (payload: unknown): void => {
      release(payload);
    },
  };
};

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('/projects', () => {
  it('draws each project as a card that leads to it, the lead named from the directory', async () => {
    await startAt();

    const link = await screen.findByRole('link', { name: 'Project 1' });
    const card = link.closest('article');

    assert(card !== null, 'the project is not drawn as a card');
    expect(link).toHaveAttribute('href', `/projects/${project(1).id}`);
    expect(within(card).getByText('BAD1')).toBeInTheDocument();
    expect(within(card).getByText('projects.list.card.lead')).toBeInTheDocument();
  });

  it('names the lead from the directory, and by id where the reader may not read it', async () => {
    await startAt({
      path: '/projects?view=%22table%22',
      list: () => json(pageOf([project(1), project(2, { leadId: OTHER_LEAD })])),
    });

    const table = await screen.findByRole('table');

    await waitFor(() => {
      expect(within(table).getByText('Anna Ivanova')).toBeInTheDocument();
    });
    expect(within(table).getByText(OTHER_LEAD)).toBeInTheDocument();
  });

  it('asks nobody for names who may not read the directory', async () => {
    await startAt({ granted: ['project:read'], path: '/projects?view=%22table%22' });

    const table = await screen.findByRole('table');

    expect(within(table).getByText(LEAD)).toBeInTheDocument();
    expect(sent.some((call) => call.url.endsWith('/employees'))).toBe(false);
  });

  it('marks the status with a word and an icon inside the card, not with a colour', async () => {
    await startAt({ list: () => json(pageOf([project(1, { status: 'ON_HOLD' })])) });

    const card = (await screen.findByRole('link', { name: 'Project 1' })).closest('article');

    assert(card !== null, 'the project is not drawn as a card');
    // Inside the card: the same word is a filter chip above the grid.
    const badge = within(card).getByText('projects.status.ON_HOLD').closest('.mantine-Badge-root');

    assert(badge !== null, 'the status is not a badge');
    expect(badge.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('sends no filter by default, leaving the archive out to the server', async () => {
    await startAt();

    await screen.findByRole('link', { name: 'Project 1' });

    const query = listCalls()[0]?.search;

    assert(query !== undefined, 'the list was never asked for');
    expect([...query.keys()].sort()).toEqual(['page', 'perPage', 'sort']);
    expect(query.get('sort')).toBe('name');
  });

  it('sends the filter the URL carries: repeated statuses, the lead, «me», the page', async () => {
    await startAt({
      path: `/projects?status=${encodeURIComponent('["ACTIVE","ON_HOLD"]')}&lead=${encodeURIComponent(
        JSON.stringify(LEAD),
      )}&member=%22me%22&q=%22bad%22&page=2`,
    });

    await screen.findByRole('link', { name: 'Project 1' });

    const query = listCalls()[0]?.search;

    assert(query !== undefined, 'the list was never asked for');
    expect(query.getAll('status')).toEqual(['ACTIVE', 'ON_HOLD']);
    expect(query.get('lead')).toBe(LEAD);
    expect(query.get('member')).toBe('me');
    expect(query.get('q')).toBe('bad');
    expect(query.get('page')).toBe('2');
  });

  it('survives rubbish in the address bar: the defaults, not the error boundary', async () => {
    await startAt({ path: '/projects?status=%22DELETED%22&page=%22abc%22&view=%22kanban%22' });

    expect(await screen.findByRole('link', { name: 'Project 1' })).toBeInTheDocument();
    expect(listCalls()[0]?.search.getAll('status')).toEqual([]);
    expect(listCalls()[0]?.search.get('page')).toBe('1');
  });

  it('puts a chosen status in the address bar and starts again from page one', async () => {
    const user = userEvent.setup();
    const app = await startAt({ path: '/projects?page=3' });

    await screen.findByRole('link', { name: 'Project 1' });

    await user.click(screen.getByRole('checkbox', { name: 'projects.status.ON_HOLD' }));

    await waitFor(() => {
      expect(app.router.state.location.search).toMatchObject({ status: ['ON_HOLD'], page: 1 });
    });
    await waitFor(() => {
      expect(listCalls().at(-1)?.search.getAll('status')).toEqual(['ON_HOLD']);
    });
  });

  it('asks for «my projects» as the word the server resolves', async () => {
    const user = userEvent.setup();

    await startAt();

    await screen.findByRole('link', { name: 'Project 1' });
    await user.click(screen.getByRole('checkbox', { name: 'projects.list.filters.mine' }));

    await waitFor(() => {
      expect(listCalls().at(-1)?.search.get('member')).toBe('me');
    });
  });

  it('offers the leads of the answer, by name, and filters by the one chosen', async () => {
    const user = userEvent.setup();
    const app = await startAt();

    await screen.findByRole('link', { name: 'Project 1' });

    const select = screen.getByLabelText('projects.list.filters.lead');

    await waitFor(() => {
      expect(within(select).getByRole('option', { name: 'Anna Ivanova' })).toBeInTheDocument();
    });
    // A lead the reader may not be named is offered by id rather than left out.
    expect(within(select).getByRole('option', { name: OTHER_LEAD })).toBeInTheDocument();

    await user.selectOptions(select, LEAD);

    await waitFor(() => {
      expect(listCalls().at(-1)?.search.get('lead')).toBe(LEAD);
    });

    // «Any lead» takes the filter off rather than sending an empty id the server would refuse.
    await user.selectOptions(select, 'projects.list.filters.anyLead');

    await waitFor(() => {
      expect(app.router.state.location.search.lead).toBeUndefined();
    });
    // The unfiltered page is served from the cache; what must never go out is `lead=` with nothing.
    expect(select).toHaveValue('');
    expect(listCalls().filter((call) => call.search.get('lead') === '')).toEqual([]);
  });

  it('types into the search box and asks once the typing stops', async () => {
    const user = userEvent.setup();
    const app = await startAt();

    await screen.findByRole('link', { name: 'Project 1' });
    const before = listCalls().length;

    await user.type(screen.getByLabelText('projects.list.filters.search'), 'bad');

    await waitFor(() => {
      expect(app.router.state.location.search).toMatchObject({ q: 'bad' });
    });
    await waitFor(() => {
      expect(listCalls().at(-1)?.search.get('q')).toBe('bad');
    });
    // One request for the word, not one per letter.
    expect(
      listCalls()
        .slice(before)
        .map((call) => call.search.get('q')),
    ).toEqual(['bad']);
  });

  it('cancels the request a newer filter has made stale', async () => {
    const user = userEvent.setup();
    const hanging = deferred();

    await startAt({
      list: (search) =>
        search.getAll('status').includes('ON_HOLD') ? hanging.answer() : json(pageOf([project(1)])),
    });

    await screen.findByRole('link', { name: 'Project 1' });
    await user.click(screen.getByRole('checkbox', { name: 'projects.status.ON_HOLD' }));

    await waitFor(() => {
      expect(listCalls().some((call) => call.search.getAll('status').includes('ON_HOLD'))).toBe(
        true,
      );
    });
    const stale = listCalls().find((call) => call.search.getAll('status').includes('ON_HOLD'));

    assert(stale !== undefined, 'the stale request was never made');
    expect(stale.signal.aborted).toBe(false);

    await user.click(screen.getByRole('checkbox', { name: 'projects.status.CLOSED' }));

    await waitFor(() => {
      expect(stale.signal.aborted).toBe(true);
    });
    // The cancellation is not a failure: no error state, the list is still there.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    act(() => {
      hanging.resolve(pageOf([]));
    });
  });

  it('keeps the previous page on screen while the next one loads — no skeleton, no blink', async () => {
    const user = userEvent.setup();
    const hanging = deferred();

    await startAt({
      list: (search) =>
        search.get('sort') === '-name' ? hanging.answer() : json(pageOf([project(1)])),
    });

    await screen.findByRole('link', { name: 'Project 1' });
    await user.selectOptions(
      screen.getByLabelText('projects.list.filters.sort'),
      screen.getByRole('option', { name: 'projects.list.sort.nameDesc' }),
    );

    await waitFor(() => {
      expect(listCalls().at(-1)?.search.get('sort')).toBe('-name');
    });
    expect(screen.getByRole('link', { name: 'Project 1' })).toBeInTheDocument();
    expect(screen.queryByTestId('card-grid-skeleton')).toBeNull();

    act(() => {
      hanging.resolve(pageOf([project(2)]));
    });

    expect(await screen.findByRole('link', { name: 'Project 2' })).toBeInTheDocument();
  });

  it('draws card placeholders on the first load, before anything came back', async () => {
    const hanging = deferred();

    await startAt({ list: () => hanging.answer() });

    expect(await screen.findByTestId('card-grid-skeleton')).toBeInTheDocument();
    act(() => {
      hanging.resolve(pageOf([project(1)]));
    });
    await screen.findByRole('link', { name: 'Project 1' });
  });

  it('switches to the table from the keyboard, keeping the page, and puts the view in the URL', async () => {
    const user = userEvent.setup();
    const app = await startAt({ path: '/projects?page=2' });

    await screen.findByRole('link', { name: 'Project 1' });

    const views = screen.getByRole('radiogroup', { name: 'projects.list.view.label' });
    const cards = within(views).getByRole('radio', { name: 'projects.list.view.grid' });

    act(() => {
      cards.focus();
    });
    await user.keyboard('{ArrowRight}');

    await waitFor(() => {
      expect(app.router.state.location.search).toMatchObject({ view: 'table', page: 2 });
    });
    const table = await screen.findByRole('table', { name: 'projects.list.view.table' });

    expect(within(table).getByRole('link', { name: 'Project 1' })).toBeInTheDocument();
    expect(within(table).getByText('projects.status.ACTIVE')).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('announces how many projects were found', async () => {
    await startAt({ list: () => json(pageOf([project(1)], 37)) });

    await screen.findByRole('link', { name: 'Project 1' });

    const announced = screen
      .getAllByRole('status')
      .map((region) => region.textContent)
      .filter((text) => text?.startsWith('projects.list.found'));

    expect(announced).toEqual(['projects.list.found']);
  });

  /**
   * One change, one announcement. The pager's range is a live region of its own on other lists;
   * here the count sentence already says it, and two polite regions changing on one filter make a
   * screen reader read the same number twice (`rules/a11y.mdc` §15). In English rather than
   * `cimode`, because a key does not change when the number in it does.
   */
  it('announces a new result count from exactly one live region', async () => {
    const user = userEvent.setup();

    await startAt({
      i18n: SharedI18n.createI18n('en'),
      language: 'en',
      list: (search) => json(pageOf([project(1)], search.get('sort') === '-name' ? 5 : 37)),
    });

    await screen.findByRole('link', { name: 'Project 1' });

    const live = (): Element[] => [
      ...document.querySelectorAll(
        '[role="status"], [aria-live="polite"], [aria-live="assertive"]',
      ),
    ];
    const mentions = (count: number): Element[] =>
      live().filter((region) =>
        new RegExp(`(^|\\D)${String(count)}(\\D|$)`).test(region.textContent ?? ''),
      );

    await waitFor(() => {
      expect(mentions(37)).not.toHaveLength(0);
    });

    await user.selectOptions(screen.getByLabelText('Order'), 'Name, Z to A');

    await waitFor(() => {
      expect(mentions(5)).not.toHaveLength(0);
    });
    expect(mentions(5).map((region) => region.textContent)).toEqual(['5 projects found']);
    expect(mentions(37)).toEqual([]);
  });

  it('shows a chip per active filter and takes one off without the others', async () => {
    const user = userEvent.setup();
    const app = await startAt({
      path: `/projects?status=${encodeURIComponent('["ACTIVE","ON_HOLD"]')}&member=%22me%22`,
    });

    await screen.findByRole('link', { name: 'Project 1' });

    // Chips stand in the order of their controls: «Active», «On hold», «My projects».
    const removes = screen.getAllByRole('button', { name: 'filter.remove' });

    expect(removes).toHaveLength(3);
    await user.click(removes[1] as HTMLElement);

    await waitFor(() => {
      expect(app.router.state.location.search).toMatchObject({ status: ['ACTIVE'], member: 'me' });
    });
  });

  it('says the filter matched nothing, and offers to take the filters off', async () => {
    const user = userEvent.setup();
    const app = await startAt({
      path: `/projects?q=%22zzz%22`,
      list: () => json(pageOf([], 0)),
    });

    expect(await screen.findByText('projects.list.empty.filteredTitle')).toBeInTheDocument();
    expect(screen.getByText('projects.list.foundNone')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'projects.list.empty.reset' }));

    await waitFor(() => {
      expect(app.router.state.location.search.q).toBeUndefined();
    });
    expect(screen.getByLabelText('projects.list.filters.search')).toHaveValue('');
  });

  /**
   * Every control that takes the filters off also takes itself off the page — the reset in the
   * empty state, the reset in the bar, the last chip's cross. Focus on a removed node falls to
   * `<body>`, and a keyboard or screen reader user is thrown to the top of the document with no word
   * about where the list went (`rules/a11y.mdc` §5, §9). The search box is always on the screen.
   */
  it("keeps the focus on the search box when the empty state's reset takes itself away", async () => {
    const user = userEvent.setup();

    await startAt({ path: `/projects?q=%22zzz%22`, list: () => json(pageOf([], 0)) });

    await user.click(await screen.findByRole('button', { name: 'projects.list.empty.reset' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'projects.list.empty.reset' })).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByLabelText('projects.list.filters.search'));
  });

  it("keeps the focus on the search box when the bar's reset takes itself away", async () => {
    const user = userEvent.setup();

    await startAt({ path: `/projects?member=%22me%22` });

    await screen.findByRole('link', { name: 'Project 1' });
    await user.click(screen.getByRole('button', { name: 'filter.reset' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'filter.reset' })).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByLabelText('projects.list.filters.search'));
  });

  it('keeps the focus on the search box when the last chip is taken off from the keyboard', async () => {
    const user = userEvent.setup();

    await startAt({ path: `/projects?member=%22me%22` });

    await screen.findByRole('link', { name: 'Project 1' });
    // From the keyboard: the cross swallows `mousedown`, so a click would never have focused it.
    act(() => {
      screen.getByRole('button', { name: 'filter.remove' }).focus();
    });
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'filter.remove' })).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByLabelText('projects.list.filters.search'));
  });

  it('tells somebody who may create a project where their projects will appear', async () => {
    await startAt({ list: () => json(pageOf([], 0)) });

    expect(await screen.findByText('projects.list.empty.title')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('projects.list.empty.canCreate')).toBeInTheDocument();
    });
    expect(screen.queryByText('projects.list.empty.askLead')).toBeNull();
    // No button to a creation form that has no route yet (STORY-014-01, client half).
    expect(within(screen.getByTestId('empty-state')).queryByRole('button')).toBeNull();
    expect(within(screen.getByTestId('empty-state')).queryByRole('link')).toBeNull();
  });

  it('tells somebody who may not create one to ask a project lead', async () => {
    await startAt({ granted: ['project:read'], list: () => json(pageOf([], 0)) });

    expect(await screen.findByText('projects.list.empty.askLead')).toBeInTheDocument();
    expect(screen.queryByText('projects.list.empty.canCreate')).toBeNull();
  });

  it('offers a way back when the list cannot be loaded', async () => {
    const user = userEvent.setup();

    await startAt({
      list: () => json({ code: 'internal_error', status: 500 }, 500),
    });

    const retry = await screen.findByRole('button', { name: /retry/i }, { timeout: 5_000 });
    const before = listCalls().length;

    expect(screen.getByText('projects.list.failed')).toBeInTheDocument();
    await user.click(retry);

    await waitFor(() => {
      expect(listCalls().length).toBeGreaterThan(before);
    });
  });

  it('turns away somebody who may not read projects, before any request for them', async () => {
    await startAt({ granted: [] });

    await waitFor(() => {
      expect(sent.some((call) => call.url.endsWith('/me/permissions'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 1, name: 'projects.list.title' })).toBeNull();
    });
    expect(listCalls()).toEqual([]);
  });

  it('has no accessibility violation, as cards or as a table', async () => {
    const user = userEvent.setup();
    const app = await startAt();

    await screen.findByRole('link', { name: 'Project 1' });

    expect(await axeViolationsIn(app.container, { control: 'aria-allowed-attr' })).toEqual([]);

    await user.click(screen.getByRole('radio', { name: 'projects.list.view.table' }));
    await screen.findByRole('table');

    expect(await axeViolationsIn(app.container, { control: 'th-has-data-cells' })).toEqual([]);
  });
});

/**
 * What the screen actually says, in both languages the product ships — every case above runs in
 * `cimode`, where a forgotten `t()` or a key missing in one catalogue renders exactly like a correct
 * one. The expectation is read from the catalogue **without fallback**, so a Russian name that fell
 * back to English fails.
 */
describe.each(['en', 'ru'] as const)('/projects in %s', (language) => {
  let i18n: I18n;

  const phrase = (key: string, namespace = 'projects'): string => {
    const value: unknown = i18n.getResource(language, namespace, key);

    assert(typeof value === 'string' && value.trim() !== '', `${namespace}.${key} is empty`);
    if (language === 'ru') expect(value).toMatch(/\p{Script=Cyrillic}/u);

    return value;
  };

  beforeEach(() => {
    i18n = SharedI18n.createI18n(language);
  });

  afterEach(async () => {
    if (i18next.language !== 'cimode') await i18next.changeLanguage('cimode');
  });

  it('names the page, the view switch, the search and the statuses in words', async () => {
    await startAt({ i18n, language });

    expect(
      await screen.findByRole('heading', { level: 1, name: phrase('list.title') }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: phrase('list.view.label') })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: phrase('list.view.table') })).toBeInTheDocument();
    expect(screen.getByLabelText(phrase('list.filters.search'))).toBeInTheDocument();
    expect(screen.getByRole('group', { name: phrase('list.filters.status') })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: phrase('status.ON_HOLD') })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: phrase('list.view.grid') })).toBeInTheDocument();
  });

  it('writes the lead on the card as a sentence of the language, with the name in it', async () => {
    await startAt({ i18n, language });

    const card = (await screen.findByRole('link', { name: 'Project 1' })).closest('article');

    assert(card !== null, 'the project is not drawn as a card');
    await waitFor(() => {
      expect(
        within(card).getByText(phrase('list.card.lead').replace('{{name}}', 'Anna Ivanova')),
      ).toBeInTheDocument();
    });
  });

  it('announces the count with the plural form of the language', async () => {
    await startAt({ i18n, language, list: () => json(pageOf([project(1)], 5)) });

    await screen.findByRole('link', { name: 'Project 1' });

    // 5 is `other` in English and `many` in Russian — the form a missing entry would get wrong.
    const form = language === 'ru' ? 'list.found_many' : 'list.found_other';

    await waitFor(() => {
      expect(screen.getAllByRole('status').map((region) => region.textContent)).toContain(
        phrase(form).replace('{{count}}', '5'),
      );
    });
  });

  it('asks somebody without the right to create a project to see a lead, in words', async () => {
    await startAt({ i18n, language, granted: ['project:read'], list: () => json(pageOf([], 0)) });

    expect(await screen.findByText(phrase('list.empty.askLead'))).toBeInTheDocument();
    expect(screen.getByText(phrase('list.empty.title'))).toBeInTheDocument();
  });
});
