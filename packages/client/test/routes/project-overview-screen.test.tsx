import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { axeViolationsIn } from '../support/axe-scan.util.js';

/**
 * `/projects/$projectId` — the project card and its overview (STORY-014-05, client half).
 *
 * Mounted as the whole application, real guards and real router, because three of the acceptances
 * are about *order* — the guard runs before the layout, the loader and the screen share one request,
 * a refusal never reaches the layout — and order is only visible from outside.
 */

/**
 * A fresh project id per case. A tree from the previous case can still be revalidating when the
 * next one mounts — a session event invalidates its router — and its late request must not be
 * mistaken for this case's: the id tells them apart.
 */
let cases = 0;
let PROJECT = '';

const nextProjectId = (): string => {
  cases += 1;

  return `018f4a3b-2c1d-7a41-9f00-${String(cases).padStart(12, '0')}`;
};
const LEAD = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b11';
const MEMBER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b12';

let sent: { url: string; method: string }[];

const platformFetch = globalThis.fetch;

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const problem = (status: number, code: string): Response =>
  new Response(JSON.stringify({ type: 'about:blank', title: 'x', status, code, requestId: 'r' }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

const card = (overrides: Record<string, unknown> = {}) => ({
  id: PROJECT,
  key: 'BAD',
  name: 'Bad CRM',
  description: 'One tool instead of six.',
  status: 'ACTIVE',
  visibility: 'PRIVATE',
  leadId: LEAD,
  color: 'brand',
  memberCount: 2,
  startedAt: '2026-09-01T00:00:00.000Z',
  dueAt: '2026-12-01T00:00:00.000Z',
  taskCounter: 0,
  createdAt: '2026-08-30T00:00:00.000Z',
  ...overrides,
});

const membership = (userId: string, projectRole: string, allocationPct: number) => ({
  userId,
  projectRole,
  allocationPct,
  joinedAt: '2026-09-01T00:00:00.000Z',
  leftAt: null,
});

const person = (userId: string, firstName: string, lastName: string) => ({
  userId,
  email: `${lastName.toLowerCase()}@example.test`,
  firstName,
  lastName,
  jobTitle: null,
  department: null,
  status: 'ACTIVE',
  managerId: null,
  roles: [],
  teams: [],
});

interface ServerOptions {
  readonly granted?: readonly string[];
  readonly detail?: () => Response;
  readonly members?: () => Response;
}

const stubServer = ({
  granted = ['project:read', 'user:read'],
  detail = () => json(card()),
  members = () => json({ items: [membership(MEMBER, 'MEMBER', 60), membership(LEAD, 'LEAD', 40)] }),
}: ServerOptions): void => {
  // Each server writes to its own log. A request still in flight from the previous case — a retry,
  // a refetch of an unmounted tree — must not land in this case's record.
  const log: { url: string; method: string }[] = [];

  sent = log;

  vi.stubGlobal('fetch', (input: Request) => {
    const url = new URL(input.url).pathname;

    log.push({ url, method: input.method });

    if (url.endsWith('/me/permissions')) {
      return Promise.resolve(
        json({ permissions: granted, denied: [], roles: [], isOwner: false, version: 1 }),
      );
    }
    if (url.endsWith(`/projects/${PROJECT}/members`)) return Promise.resolve(members());
    if (url.endsWith(`/projects/${PROJECT}`)) return Promise.resolve(detail());
    if (url.endsWith('/employees')) {
      const people = [person(LEAD, 'Anna', 'Ivanova'), person(MEMBER, 'Oleg', 'Petrov')];

      return Promise.resolve(
        json({
          items: people,
          total: people.length,
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

const startAt = async (options: ServerOptions = {}) => {
  vi.resetModules();
  PROJECT = nextProjectId();
  stubServer(options);

  const { renderApp } = await import('../support/render-app.util.js');

  return renderApp({ path: `/projects/${PROJECT}`, status: 'authenticated' });
};

const detailCalls = () => sent.filter((call) => call.url.endsWith(`/projects/${PROJECT}`));
const projectCalls = () => sent.filter((call) => call.url.includes(`/projects/${PROJECT}`));

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('/projects/$projectId', () => {
  it('draws the head of the project: key, name, status, visibility, lead by name, dates', async () => {
    await startAt();

    expect(await screen.findByRole('heading', { level: 2, name: 'Bad CRM' })).toBeInTheDocument();
    expect(screen.getByText('BAD')).toBeInTheDocument();
    expect(screen.getByText('projects.status.ACTIVE')).toBeInTheDocument();
    expect(screen.getByText('projects.visibility.PRIVATE')).toBeInTheDocument();
    const leadLabel = screen.getByText('projects.header.lead');

    // The lead's value sits beside its label; the directory names them once it answers.
    await waitFor(() => {
      expect(leadLabel.nextElementSibling).toHaveTextContent('Anna Ivanova');
    });
    expect(screen.getByText(/^projects\.header\.startedAt/)).toBeInTheDocument();
    expect(screen.getByText(/^projects\.header\.dueAt/)).toBeInTheDocument();
    expect(screen.queryByText(/^projects\.archived\.title$/)).not.toBeInTheDocument();
  });

  it('asks for the card once — the guard, the loader and the screen share one cache entry', async () => {
    await startAt();

    await screen.findByRole('heading', { level: 2, name: 'Bad CRM' });
    await screen.findByText('Oleg Petrov');

    expect(detailCalls()).toHaveLength(1);
  });

  it('lays the sections out as a tab list: the overview selected, the rest declared and disabled', async () => {
    await startAt();

    const tablist = await screen.findByRole('tablist', { name: 'projects.section.label' });
    const tabs = within(tablist).getAllByRole('tab');

    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'projects.section.overview',
      'projects.section.membersprojects.section.soon',
      'projects.section.filesprojects.section.soon',
      'projects.section.boardsprojects.section.soon',
      'projects.section.docsprojects.section.soon',
      'projects.section.timeprojects.section.soon',
      'projects.section.settingsprojects.section.soon',
    ]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toBeEnabled();
    for (const tab of tabs.slice(1)) expect(tab).toBeDisabled();
    // No section leads anywhere yet: a disabled tab is not a link to a route that does not exist.
    expect(within(tablist).queryAllByRole('link')).toEqual([]);
  });

  it('shows the overview from real data: description, progress by dates, the team with roles and allocation', async () => {
    await startAt();

    expect(await screen.findByText('One tool instead of six.')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'projects.dates.progressLabel' }),
    ).toBeInTheDocument();

    const rows = within(await screen.findByRole('table'))
      .getAllByRole('row')
      .slice(1);

    // The lead first, whatever the joining order; names from the directory, not ids.
    expect(rows.map((row) => within(row).getAllByRole('cell')[0]?.textContent)).toEqual([
      'Anna Ivanova',
      'Oleg Petrov',
    ]);
    expect(within(rows[0]!).getByText('projects.role.LEAD')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('projects.team.allocation')).toBeInTheDocument();
  });

  it('says what is coming for the domains not built yet, instead of an empty chart', async () => {
    await startAt();

    await screen.findByRole('heading', { level: 2, name: 'projects.upcoming.title' });

    for (const block of ['activity', 'tasks', 'time', 'ci']) {
      expect(
        screen.getByRole('heading', { level: 3, name: `projects.upcoming.${block}` }),
      ).toBeInTheDocument();
    }
    expect(screen.getAllByText('projects.upcoming.later')).toHaveLength(4);
  });

  it('shows ids — and asks the directory nothing — for a reader without user:read', async () => {
    await startAt({ granted: ['project:read'] });

    const rows = within(await screen.findByRole('table'))
      .getAllByRole('row')
      .slice(1);

    expect(rows.map((row) => within(row).getAllByRole('cell')[0]?.textContent)).toEqual([
      LEAD,
      MEMBER,
    ]);
    expect(sent.some((call) => call.url.endsWith('/employees'))).toBe(false);
  });

  it('says an archived project cannot be changed', async () => {
    await startAt({ detail: () => json(card({ status: 'ARCHIVED' })) });

    expect(await screen.findByText('projects.archived.title')).toBeInTheDocument();
    expect(screen.getByText('projects.archived.description')).toBeInTheDocument();
    expect(screen.getByText('projects.status.ARCHIVED')).toBeInTheDocument();
  });

  it('says in words that the deadline has passed, not only in the colour of the bar', async () => {
    await startAt({
      detail: () =>
        json(card({ startedAt: '2026-01-01T00:00:00.000Z', dueAt: '2026-02-01T00:00:00.000Z' })),
    });

    expect(await screen.findByText('projects.dates.overdue')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'projects.dates.progressLabel' }),
    ).toHaveAttribute('aria-valuenow', '100');
  });

  it('paints the project colour as a decorative swatch, and nothing for a name off the palette', async () => {
    const { unmount } = await startAt();

    await screen.findByRole('heading', { level: 2, name: 'Bad CRM' });

    // CONTROL: a palette name paints a swatch, hidden from assistive technology.
    const swatch = document.querySelector('.mantine-ColorSwatch-root');

    expect(swatch).not.toBeNull();
    expect(swatch).toHaveAttribute('aria-hidden', 'true');

    unmount();
    await startAt({ detail: () => json(card({ color: 'Not-A-Palette' })) });
    await screen.findByRole('heading', { level: 2, name: 'Bad CRM' });

    expect(document.querySelector('.mantine-ColorSwatch-root')).toBeNull();
  });

  it('asks the reader to set dates rather than drawing a bar over a span that does not exist', async () => {
    await startAt({ detail: () => json(card({ dueAt: null, description: null })) });

    expect(await screen.findByText('projects.dates.noSpan')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('projects.overview.noDescription')).toBeInTheDocument();
  });

  it.each([
    { status: 404, code: 'project_not_found' },
    { status: 403, code: 'user_forbidden' },
  ])(
    'answers $status with the not-found screen before the layout — and asks for nothing under it',
    async ({ status, code }) => {
      await startAt({ detail: () => problem(status, code) });

      expect(await screen.findByText('errors.not_found.title')).toBeInTheDocument();
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { level: 1, name: 'projects.detail.title' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 2, name: 'Bad CRM' })).not.toBeInTheDocument();
      // The layout never ran, so neither did the roster under it. (That a refusal is not retried
      // is pinned by the guard's own test: here a session event may revalidate the route.)
      expect(projectCalls().some((call) => call.url.endsWith('/members'))).toBe(false);
    },
  );

  it('does not ask for a project at all without project:read — the same not-found screen', async () => {
    await startAt({ granted: [] });

    expect(await screen.findByText('errors.not_found.title')).toBeInTheDocument();
    expect(projectCalls()).toEqual([]);
  });

  it('shows a failed load as an error state with a retry that loads the project', async () => {
    const user = userEvent.setup();
    let failing = true;

    await startAt({ detail: () => (failing ? problem(500, 'internal_error') : json(card())) });

    const retry = await screen.findByRole(
      'button',
      { name: /common\.retry|errors\.retry/ },
      { timeout: 5_000 },
    );

    expect(screen.getByText('errors.route.failed')).toBeInTheDocument();
    expect(screen.queryByText('errors.not_found.title')).not.toBeInTheDocument();

    failing = false;
    await user.click(retry);

    expect(await screen.findByRole('heading', { level: 2, name: 'Bad CRM' })).toBeInTheDocument();
  });

  it('keeps the card on screen when only the roster fails, with an inline retry and no toast', async () => {
    const user = userEvent.setup();
    let failing = true;

    await startAt({
      members: () =>
        failing ? problem(500, 'internal_error') : json({ items: [membership(LEAD, 'LEAD', 40)] }),
    });

    expect(
      await screen.findByText('projects.team.failed', {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Bad CRM' })).toBeInTheDocument();
    // One signal for one failure: the inline state, and no toast beside it.
    expect(document.querySelector('.mantine-Notification-root')).toBeNull();

    failing = false;

    const section = screen
      .getByRole('heading', { level: 2, name: 'projects.overview.team' })
      .closest('section');

    await user.click(within(section!).getByRole('button'));

    expect(await screen.findByText('Anna Ivanova', { selector: 'td p' })).toBeInTheDocument();
  });

  it('has no axe violations on the rendered card', async () => {
    const { container } = await startAt();

    await screen.findByText('Oleg Petrov');
    await waitFor(() => {
      expect(screen.queryByTestId('text-skeleton')).not.toBeInTheDocument();
    });

    expect(await axeViolationsIn(container, { control: 'aria-allowed-attr' })).toEqual([]);
  });
});
