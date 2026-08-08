import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/admin/members` — the directory.
 *
 * What only shows up at this level is the round trip through the **address bar**: the filter is the
 * URL, so a change has to land there, reset the page, and go out as a request with the same
 * parameters. Plus what a screen can get wrong on its own — offering the chart to somebody who may
 * not see it, and drawing a person whose personnel record nobody has filled in yet.
 *
 * There is deliberately **no** case here asserting that a public document shows no employment. The
 * table has no employment column at any permission level, so such a test cannot fail: it passed
 * against a fixture that never carried the field, and it would pass against a deleted component.
 * That property is asserted where it is decided and where it *can* fail — `employee-list-serializer`
 * on the server, which folds a row per audience and carries a positive control for each.
 */

const ROLE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af2';
const TEAM = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af3';

let sent: { url: string; search: URLSearchParams }[];

const platformFetch = globalThis.fetch;

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const person = (index: number, overrides: Record<string, unknown> = {}) => ({
  userId: `018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a${String(index).padStart(2, '0')}`,
  email: `person-${index}@example.test`,
  firstName: 'Ivan',
  lastName: `Petrov-${index}`,
  jobTitle: 'Backend engineer',
  department: 'Platform',
  status: 'ACTIVE',
  managerId: null,
  roles: [{ id: ROLE, key: 'developer', name: 'Developer' }],
  teams: [{ id: TEAM, name: 'Platform' }],
  ...overrides,
});

const stubServer = (options: {
  readonly granted?: string[];
  readonly total?: number;
  readonly row?: Record<string, unknown>;
}): void => {
  vi.stubGlobal('fetch', (input: Request) => {
    const url = new URL(input.url);

    sent.push({ url: url.pathname, search: url.searchParams });

    if (url.pathname.endsWith('/me/permissions')) {
      return Promise.resolve(
        json({
          permissions: options.granted ?? [],
          denied: [],
          roles: [],
          isOwner: false,
          version: 1,
        }),
      );
    }
    if (url.pathname.endsWith('/employees/org-chart')) {
      return Promise.resolve(
        json({
          nodes: [
            {
              userId: person(1).userId,
              firstName: 'Ivan',
              lastName: 'Petrov-1',
              jobTitle: 'Lead',
              managerId: null,
            },
            {
              userId: person(2).userId,
              firstName: 'Olga',
              lastName: 'Petrov-2',
              jobTitle: null,
              managerId: person(1).userId,
            },
            // Nobody has filled this person's name in yet: the chart still has to draw them, and an
            // empty label would be an unclickable node.
            {
              userId: person(3).userId,
              firstName: '',
              lastName: '',
              jobTitle: null,
              managerId: null,
            },
          ],
        }),
      );
    }
    if (url.pathname.endsWith('/employees')) {
      const total = options.total ?? 1;

      return Promise.resolve(
        json({
          items: total === 0 ? [] : [person(1, options.row ?? {})],
          total,
          page: Number(url.searchParams.get('page') ?? '1'),
          perPage: 25,
          sort: url.searchParams.get('sort') ?? 'name',
          facets: {
            roles: [{ id: ROLE, key: 'developer', name: 'Developer' }],
            teams: [{ id: TEAM, name: 'Platform' }],
          },
        }),
      );
    }

    return Promise.resolve(json({ status: 'ok' }));
  });
};

const startAt = async (
  options: {
    readonly granted?: string[];
    readonly total?: number;
    readonly path?: string;
    readonly row?: Record<string, unknown>;
  } = {},
): Promise<ReturnType<typeof import('../support/render-app.util.js').renderApp>> => {
  vi.resetModules();
  stubServer(options);

  const { renderApp } = await import('../support/render-app.util.js');

  return renderApp({ path: options.path ?? '/admin/members', status: 'authenticated' });
};

const directoryCalls = (): { url: string; search: URLSearchParams }[] =>
  sent.filter((call) => call.url.endsWith('/employees'));

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('/admin/members', () => {
  it('sends the filter the URL carries, and shows what came back', async () => {
    await startAt({
      granted: ['user:read', 'employee:read'],
      path: `/admin/members?status=%5B%22SUSPENDED%22%5D&page=2`,
    });

    expect(await screen.findByText('person-1@example.test')).toBeInTheDocument();

    const query = directoryCalls()[0]?.search;

    expect(query?.getAll('status')).toEqual(['SUSPENDED']);
    expect(query?.get('page')).toBe('2');
  });

  it('sends the default filter as an empty one, letting the server decide the statuses', async () => {
    // Which statuses «no filter» means is the server's decision, stated once — a client that filled
    // in `ACTIVE,INVITED` itself would be a second place to change when it stops being true.
    await startAt({ granted: ['user:read', 'employee:read'] });

    await screen.findByText('person-1@example.test');

    expect(directoryCalls()[0]?.search.getAll('status')).toEqual([]);
  });

  it('puts a chosen filter in the address bar and starts again from page one', async () => {
    const user = userEvent.setup();
    const app = await startAt({
      granted: ['user:read', 'employee:read'],
      path: `/admin/members?page=3`,
    });

    await screen.findByText('person-1@example.test');

    await user.click(screen.getByRole('checkbox', { name: /members\.status\.SUSPENDED/ }));

    await waitFor(() => {
      expect(app.router.state.location.search).toMatchObject({
        status: ['SUSPENDED'],
        page: 1,
      });
    });
  });

  it('offers no org chart to somebody who may not see one', async () => {
    await startAt({ granted: ['user:read', 'employee:read'] });

    await screen.findByText('person-1@example.test');

    // An option that always answers 403 is a dead end the reader has to walk into to discover.
    expect(screen.queryByRole('radiogroup', { name: /members\.view\.label/ })).toBeNull();
    expect(sent.some((call) => call.url.endsWith('/employees/org-chart'))).toBe(false);
  });

  it('draws the chart, and only once the view asks for it', async () => {
    const user = userEvent.setup();

    await startAt({ granted: ['user:read', 'employee:read', 'employee:view_org_chart'] });

    await screen.findByText('person-1@example.test');
    // Not fetched while the table is on show: a request for a picture nobody is looking at.
    expect(sent.some((call) => call.url.endsWith('/employees/org-chart'))).toBe(false);

    await user.click(screen.getByRole('radio', { name: /members\.view\.chart/ }));

    expect(await screen.findByRole('link', { name: 'Olga Petrov-2' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: person(3).userId })).toBeInTheDocument();
  });

  it('offers a way back when the chart cannot be loaded', async () => {
    const user = userEvent.setup();

    vi.resetModules();
    vi.stubGlobal('fetch', (input: Request) => {
      const url = new URL(input.url);

      sent.push({ url: url.pathname, search: url.searchParams });

      if (url.pathname.endsWith('/me/permissions')) {
        return Promise.resolve(
          json({
            permissions: ['user:read', 'employee:read', 'employee:view_org_chart'],
            denied: [],
            roles: [],
            isOwner: false,
            version: 1,
          }),
        );
      }
      if (url.pathname.endsWith('/employees/org-chart')) {
        return Promise.resolve(
          new Response(JSON.stringify({ code: 'internal_error', status: 500 }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }

      return Promise.resolve(
        json({
          items: [person(1)],
          total: 1,
          page: 1,
          perPage: 25,
          sort: 'name',
          facets: { roles: [], teams: [] },
        }),
      );
    });

    const { renderApp } = await import('../support/render-app.util.js');

    renderApp({ path: '/admin/members?view=%22chart%22', status: 'authenticated' });

    const retry = await screen.findByRole('button', { name: /retry/i });
    const chartCalls = (): number =>
      sent.filter((call) => call.url.endsWith('/employees/org-chart')).length;
    const before = chartCalls();

    await user.click(retry);

    await waitFor(() => {
      expect(chartCalls()).toBeGreaterThan(before);
    });
  });

  it('types into the search box and asks again once the typing stops', async () => {
    const user = userEvent.setup();
    const app = await startAt({ granted: ['user:read', 'employee:read'] });

    await screen.findByText('person-1@example.test');

    await user.type(screen.getByLabelText(/members\.filters\.search/), 'ив');

    await waitFor(() => {
      expect(app.router.state.location.search).toMatchObject({ q: 'ив' });
    });
    await waitFor(() => {
      expect(directoryCalls().at(-1)?.search.get('q')).toBe('ив');
    });
  });

  it('says so when the filter matched nobody, differently from an empty organization', async () => {
    await startAt({
      granted: ['user:read', 'employee:read'],
      total: 0,
      path: `/admin/members?q=%22zzz%22`,
    });

    expect(await screen.findByText(/members\.empty\.filtered/)).toBeInTheDocument();
  });

  it('falls back to the e-mail for somebody with no name yet', async () => {
    // An invitation accepted this morning: an account exists, the personnel record does not. A blank
    // cell would read as a defect and leave the row unclickable in practice.
    await startAt({
      granted: ['user:read', 'employee:read'],
      row: { firstName: '', lastName: '' },
    });

    expect(await screen.findByRole('link', { name: 'person-1@example.test' })).toBeInTheDocument();
  });

  it('marks a deactivated colleague with a word, not only with a colour', async () => {
    // WCAG 1.4.1: colour is never the only carrier of meaning.
    await startAt({ granted: ['user:read', 'employee:read'], row: { status: 'SUSPENDED' } });

    // Inside the row: the same string is also a filter chip above the table, and asserting on the
    // document would pass with the badge missing entirely.
    const row = (await screen.findByText('person-1@example.test')).closest('tr');

    expect(within(row as HTMLElement).getByText(/members\.status\.SUSPENDED/)).toBeInTheDocument();
  });

  it('shows a dash where a field was never filled in', async () => {
    await startAt({
      granted: ['user:read', 'employee:read'],
      row: { jobTitle: null, department: null },
    });

    await screen.findByText('person-1@example.test');
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('has no accessibility violation, as a table or as a chart', async () => {
    const user = userEvent.setup();
    const app = await startAt({
      granted: ['user:read', 'employee:read', 'employee:view_org_chart'],
    });

    await screen.findByText('person-1@example.test');

    const table = await axe.run(app.container, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(table.violations.map((violation) => violation.id)).toEqual([]);

    await user.click(screen.getByRole('radio', { name: /members\.view\.chart/ }));
    await screen.findByRole('link', { name: 'Olga Petrov-2' });

    const chart = await axe.run(app.container, {
      rules: { 'color-contrast': { enabled: false } },
    });

    // Nested `ul`/`li` is what makes the structure reachable from a screen reader and a keyboard; a
    // chart drawn with absolute positions is a picture of one.
    expect(chart.violations.map((violation) => violation.id)).toEqual([]);
    expect(app.container.querySelectorAll('ul ul').length).toBeGreaterThan(0);
  });

  it('offers the way to invite a colleague only to somebody who may', async () => {
    await startAt({ granted: ['user:read', 'employee:read'] });

    await screen.findByText('person-1@example.test');
    expect(screen.queryByRole('link', { name: /members\.invite\.title/ })).toBeNull();
  });

  it('shows it to somebody holding invitation:create', async () => {
    await startAt({ granted: ['user:read', 'employee:read', 'invitation:create'] });

    expect(await screen.findByRole('link', { name: /members\.invite\.title/ })).toBeInTheDocument();
  });

  it('sends a chosen role and a chosen team as the filter they are', async () => {
    const user = userEvent.setup();

    await startAt({ granted: ['user:read', 'employee:read'] });

    await screen.findByText('person-1@example.test');

    await user.click(screen.getByRole('checkbox', { name: 'Developer' }));
    await user.click(screen.getByRole('checkbox', { name: 'Platform' }));

    await waitFor(() => {
      const last = directoryCalls().at(-1)?.search;

      expect(last?.getAll('role')).toEqual([ROLE]);
      expect(last?.getAll('team')).toEqual([TEAM]);
    });
  });

  it('reorders on demand, and puts the order in the address bar', async () => {
    const user = userEvent.setup();
    const app = await startAt({
      granted: ['user:read', 'employee:read', 'employee:view_personal_data'],
    });

    await screen.findByText('person-1@example.test');

    await user.selectOptions(
      screen.getByLabelText(/members\.filters\.sort/),
      screen.getByRole('option', { name: /members\.sort\.hiredAtDesc/ }),
    );

    await waitFor(() => {
      expect(app.router.state.location.search).toMatchObject({ sort: '-hiredAt' });
    });
  });

  it('takes the filters back off in one gesture', async () => {
    const user = userEvent.setup();
    const app = await startAt({
      granted: ['user:read', 'employee:read'],
      path: `/admin/members?q=%22ив%22`,
    });

    await screen.findByText('person-1@example.test');

    await user.click(screen.getByRole('button', { name: /members\.filters\.reset/ }));

    await waitFor(() => {
      expect(app.router.state.location.search).toMatchObject({ q: '', role: [], team: [] });
    });
  });

  it('offers a way back when the directory cannot be loaded', async () => {
    // `DataState` owns the four states; what this asserts is that the retry re-asks rather than
    // being a button that does nothing.
    const user = userEvent.setup();

    vi.resetModules();
    vi.stubGlobal('fetch', (input: Request) => {
      const url = new URL(input.url);

      sent.push({ url: url.pathname, search: url.searchParams });

      if (url.pathname.endsWith('/me/permissions')) {
        return Promise.resolve(
          json({
            permissions: ['user:read', 'employee:read'],
            denied: [],
            roles: [],
            isOwner: false,
            version: 1,
          }),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({ code: 'internal_error', status: 500 }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const { renderApp } = await import('../support/render-app.util.js');

    renderApp({ path: '/admin/members', status: 'authenticated' });

    const retry = await screen.findByRole('button', { name: /retry/i });
    const before = directoryCalls().length;

    await user.click(retry);

    await waitFor(() => {
      expect(directoryCalls().length).toBeGreaterThan(before);
    });
  });

  it('turns somebody away who may not read the directory at all', async () => {
    await startAt({ granted: [] });

    // The route guard, before the screen renders — and before a request is made.
    await waitFor(() => {
      expect(sent.every((call) => !call.url.endsWith('/employees'))).toBe(true);
    });
    expect(screen.queryByRole('table')).toBeNull();
  });
});
