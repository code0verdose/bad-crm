import { MantineProvider } from '@mantine/core';
import { RouterContextProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@app/router.js';
import { SharedApi, SharedUi } from '@shared';
import { IamLib } from '@units/iam';
import { BreadcrumbTrail, BreadcrumbsLib } from '@widgets/breadcrumbs';

import { renderApp } from '../support/render-app.util.js';

/**
 * The trail, derived from the route tree rather than written per page.
 *
 * The rules being enforced are the two that make breadcrumbs useful instead of decorative: a route
 * that carries no label is not in the trail (the pathless `_authenticated` layout must not appear
 * as an empty step), and the last crumb is the page you are on — which is why it is text, and why
 * it has to equal the `h1`.
 */

describe('building the trail', () => {
  it('skips routes that declare no label', () => {
    const crumbs = BreadcrumbsLib.routeCrumbs([
      { pathname: '/' },
      { pathname: '/', staticData: {} },
      { pathname: '/projects', staticData: { crumbKey: 'nav.projects' } },
    ]);

    expect(crumbs.map((crumb) => crumb.labelKey)).toEqual(['nav.projects']);
  });

  it('marks only the last crumb as the current page', () => {
    const crumbs = BreadcrumbsLib.routeCrumbs([
      { pathname: '/projects', staticData: { crumbKey: 'nav.projects' } },
      { pathname: '/projects/42', staticData: { crumbKey: 'nav.dashboard' } },
    ]);

    expect(crumbs.map((crumb) => crumb.isCurrent)).toEqual([false, true]);
  });

  it('reports the current page as the last labelled route', () => {
    expect(
      BreadcrumbsLib.currentCrumbKey([
        { pathname: '/' },
        { pathname: '/dashboard', staticData: { crumbKey: 'nav.dashboard' } },
      ]),
    ).toBe('nav.dashboard');
  });

  it('reports nothing on a route that declares no label at all', () => {
    expect(BreadcrumbsLib.currentCrumbKey([{ pathname: '/' }])).toBeUndefined();
  });
});

/**
 * A match a stand-in screen replaced — not found, 403, or an ordinary failure — is named by that
 * screen's heading, and nothing under it names the page: it does not render. The failure too: its
 * error screen replaces the card, heading included, and the `h1` the reader lands on says the page
 * did not load, so the last crumb, the title and the announcement say the same.
 */
describe('a match a stand-in screen replaced', () => {
  const projects = { pathname: '/projects', staticData: { crumbKey: 'nav.projects' } };
  const project = { pathname: '/projects/42', staticData: { crumbKey: 'projects.detail.title' } };
  const overview = { pathname: '/projects/42/', staticData: { crumbKey: 'projects.overview' } };

  it('names the page by the not-found heading and drops what is under it', () => {
    expect(
      BreadcrumbsLib.routeCrumbs([
        projects,
        { ...project, status: 'notFound' },
        { ...overview, status: 'pending' },
      ]),
    ).toEqual([
      { labelKey: 'nav.projects', pathname: '/projects', isCurrent: false },
      { labelKey: 'errors.not_found.title', pathname: '/projects/42', isCurrent: true },
    ]);
  });

  it('names a replaced layout that declares no crumb of its own', () => {
    expect(BreadcrumbsLib.currentCrumbKey([{ pathname: '/', status: 'notFound' }])).toBe(
      'errors.not_found.title',
    );
  });

  it('names the page by the 403 heading when the failure is a refusal', () => {
    expect(
      BreadcrumbsLib.currentCrumbKey([
        projects,
        { ...project, status: 'error', error: new IamLib.PermissionDeniedError('project:read') },
      ]),
    ).toBe('errors.forbidden.title');
  });

  it('names the page by the error heading on an ordinary failure, and keeps the trail above it', () => {
    expect(
      BreadcrumbsLib.routeCrumbs([
        projects,
        { ...project, status: 'error', error: new Error('boom') },
        { ...overview, status: 'pending' },
      ]),
    ).toEqual([
      { labelKey: 'nav.projects', pathname: '/projects', isCurrent: false },
      { labelKey: 'errors.route.title', pathname: '/projects/42', isCurrent: true },
    ]);
  });

  it('keeps the page name while it loads and once it has', () => {
    expect(BreadcrumbsLib.currentCrumbKey([{ ...project, status: 'pending' }])).toBe(
      'projects.detail.title',
    );
    expect(BreadcrumbsLib.currentCrumbKey([{ ...project, status: 'success' }])).toBe(
      'projects.detail.title',
    );
  });
});

/**
 * STORY-014-06, acceptance 8: a page named by its data — a project — says which one. The route
 * declares its crumb key as every route does; the name comes in beside the matches, by route id,
 * from the cache the route's guard filled (`useRouteCrumbs`). A stand-in screen still wins: a
 * project that answered «not found» is not named, the refusal is.
 */
describe('a crumb named by its data', () => {
  const LAYOUT = '/_authenticated/projects/$projectId';
  const projects = { pathname: '/projects', staticData: { crumbKey: 'projects.list.title' } };
  const project = {
    routeId: LAYOUT,
    pathname: '/projects/42',
    staticData: { crumbKey: 'projects.detail.title' },
  };
  const titles = { [LAYOUT]: 'BAD · Bad CRM' };

  it('carries the title the route id is given, beside its key', () => {
    expect(BreadcrumbsLib.routeCrumbs([projects, project], titles)).toEqual([
      { labelKey: 'projects.list.title', pathname: '/projects', isCurrent: false },
      {
        labelKey: 'projects.detail.title',
        title: 'BAD · Bad CRM',
        pathname: '/projects/42',
        isCurrent: true,
      },
    ]);
  });

  it('CONTROL: keeps the key alone while there is no title to give', () => {
    expect(BreadcrumbsLib.routeCrumbs([project], {})).toEqual([
      { labelKey: 'projects.detail.title', pathname: '/projects/42', isCurrent: true },
    ]);
  });

  it.each([
    { status: 'notFound', error: undefined, key: 'errors.not_found.title' },
    { status: 'error', error: new Error('boom'), key: 'errors.route.title' },
  ])('names a $status by its stand-in, not by the project', ({ status, error, key }) => {
    expect(BreadcrumbsLib.currentCrumb([projects, { ...project, status, error }], titles)).toEqual({
      labelKey: key,
      pathname: '/projects/42',
      isCurrent: true,
    });
  });

  /**
   * What the route announcer keys a page on. Another project is another page — focus goes to its
   * heading — but the same project renamed is the same page: saving a new name on the settings tab
   * must not throw focus out of the form.
   */
  describe('the identity of the page', () => {
    const named = (pathname: string, title: string) =>
      BreadcrumbsLib.crumbIdentity({
        labelKey: 'projects.detail.title',
        title,
        pathname,
        isCurrent: true,
      });

    it('differs between two projects', () => {
      expect(named('/projects/42', 'BAD · Bad CRM')).not.toBe(named('/projects/43', 'OTH · Other'));
    });

    it('stays when the same project is renamed', () => {
      expect(named('/projects/42', 'BAD · Bad CRM')).toBe(named('/projects/42', 'BAD · Renamed'));
    });

    it('is the key alone for a page named by its key, wherever it is', () => {
      expect(
        BreadcrumbsLib.crumbIdentity({
          labelKey: 'teams.detail.title',
          pathname: '/admin/teams/1',
          isCurrent: true,
        }),
      ).toBe('teams.detail.title');
    });
  });
});

const TWO_CRUMBS = [
  { labelKey: 'nav.projects', pathname: '/projects', isCurrent: false },
  { labelKey: 'nav.dashboard', pathname: '/projects/42', isCurrent: true },
];

/**
 * A router context without a route tree rendered under it: `Link` needs one to resolve an `href`,
 * and mounting the whole application would put the trail back where it cannot be given two crumbs.
 */
const Standalone = ({ children }: { readonly children: ReactNode }) => {
  const router = createAppRouter(
    {
      queryClient: SharedApi.createAppQueryClient({ notify: SharedUi.notify, logError: vi.fn() }),
      auth: { status: 'authenticated' },
    },
    createMemoryHistory({ initialEntries: ['/dashboard'] }),
  );

  return (
    <MantineProvider env="test">
      <RouterContextProvider router={router}>{children}</RouterContextProvider>
    </MantineProvider>
  );
};

describe('rendering the trail', () => {
  it('links every crumb but the last one', () => {
    render(
      <Standalone>
        <BreadcrumbTrail crumbs={TWO_CRUMBS} />
      </Standalone>,
    );

    const trail = screen.getByLabelText('nav.breadcrumbs.aria');
    expect(within(trail).getAllByRole('link')).toHaveLength(1);
    expect(within(trail).getByRole('link')).toHaveTextContent('nav.projects');
  });

  /** The page you are on is text with `aria-current`, not a link back to itself. */
  it('marks the current page instead of linking to it', () => {
    render(
      <Standalone>
        <BreadcrumbTrail crumbs={TWO_CRUMBS} />
      </Standalone>,
    );

    expect(screen.getByText('nav.dashboard')).toHaveAttribute('aria-current', 'page');
  });

  /** The project's own words, as they are: a key and a name are data, not a translation. */
  it('shows a crumb’s title rather than its key when it has one', () => {
    render(
      <Standalone>
        <BreadcrumbTrail
          crumbs={[
            { labelKey: 'nav.projects', pathname: '/projects', isCurrent: false },
            {
              labelKey: 'projects.detail.title',
              title: 'BAD · Bad CRM',
              pathname: '/projects/42',
              isCurrent: true,
            },
          ]}
        />
      </Standalone>,
    );

    expect(screen.getByText('BAD · Bad CRM')).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('projects.detail.title')).toBeNull();
  });

  it('renders nothing at all for a single crumb', () => {
    const { container } = render(
      <Standalone>
        <BreadcrumbTrail crumbs={[TWO_CRUMBS[0] as (typeof TWO_CRUMBS)[number]]} />
      </Standalone>,
    );

    expect(container.querySelector('[aria-label="nav.breadcrumbs.aria"]')).toBeNull();
  });

  /** One crumb is the page title repeated; the widget stays out of the way. */
  it('renders nothing when the trail would have a single entry', async () => {
    renderApp({ path: '/dashboard' });
    await screen.findByRole('main');

    expect(
      screen.queryByRole('navigation', { name: 'nav.breadcrumbs.aria' }),
    ).not.toBeInTheDocument();
  });
});
