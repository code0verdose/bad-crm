import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The matrix screen end to end, against a stubbed server.
 *
 * The parts were proved separately — the draft as a hook, the cells and the summary as components,
 * the policy on the server. What only shows up here is that they are **wired**: the guard runs
 * before the first frame, a click on a cell reaches the draft, Save asks for a preview before it
 * writes, and the write goes out exactly once with the composition the person assembled.
 *
 * `openapi-fetch` captures `globalThis.fetch` when the client module is evaluated, so the stub has
 * to be in place **before** the import — hence `resetModules` and the dynamic import of the render
 * helper in each case, the same trap `sign-in-flow.test.tsx` documents.
 */

const ROLE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a61';
const SYSTEM_ROLE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a62';

const permissions = (granted: readonly string[]): unknown => ({
  permissions: granted,
  denied: [],
  roles: ['admin'],
  isOwner: false,
  version: 1,
});

const roles = {
  items: [
    {
      id: ROLE,
      key: 'tech_writer',
      name: 'Technical writer',
      description: null,
      isSystem: false,
      isDefault: false,
      holderCount: 2,
      permissions: ['task:read'],
    },
    {
      id: SYSTEM_ROLE,
      key: 'manager',
      name: 'Manager',
      description: null,
      isSystem: true,
      isDefault: false,
      holderCount: 5,
      permissions: ['task:read'],
    },
  ],
};

const preview = {
  items: [
    {
      roleId: ROLE,
      key: 'tech_writer',
      name: 'Technical writer',
      isSystem: false,
      holderCount: 2,
      added: ['task:update'],
      removed: [],
      dangerous: [],
      reason: null,
    },
  ],
};

let sent: { url: string; method: string; body: unknown; confirmed?: string | null }[];

/**
 * Restored one global at a time, never with `unstubAllGlobals`: the suite's setup stubs
 * `matchMedia`, `ResizeObserver` and `scrollTo` — the parts of the platform jsdom is missing — and
 * clearing every stub takes those with it, leaving the *next* case in this file rendering Mantine
 * without them.
 */
const platformFetch = globalThis.fetch;

const json = (payload: unknown, status = 200): Response =>
  new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** The server as this screen meets it: permissions, the matrix, the preview and the save. */
const startAt = async (
  path: string,
  granted: readonly string[],
  options: {
    readonly failApply?: boolean;
    readonly dangerous?: boolean;
    readonly failRoles?: boolean;
  } = {},
): Promise<{
  router: {
    state: { location: { search: unknown; pathname: string } };
    navigate: (options: { to: string }) => Promise<void>;
  };
}> => {
  vi.resetModules();
  stubServer(granted, options);

  const { renderApp } = await import('../support/render-app.util.js');

  return renderApp({ path, status: 'authenticated' });
};

const EDITOR = ['role:read', 'role:update', 'task:read', 'task:update', 'user:impersonate'];

const stubServer = (
  granted: readonly string[],
  options: {
    readonly failApply?: boolean;
    readonly dangerous?: boolean;
    readonly failRoles?: boolean;
  } = {},
): void => {
  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url).pathname;
    const body = input.method === 'POST' ? await input.clone().json() : undefined;

    sent.push({
      url,
      method: input.method,
      body,
      confirmed: input.headers.get('X-Confirm-Dangerous'),
    });

    if (url.endsWith('/me/permissions')) return json(permissions(granted));
    if (url.endsWith('/roles/preview-changes')) {
      return json(
        options.dangerous === true
          ? {
              items: [
                {
                  ...preview.items[0],
                  added: ['user:impersonate'],
                  dangerous: ['user:impersonate'],
                },
              ],
            }
          : preview,
      );
    }
    if (url.endsWith('/roles/apply-changes')) {
      return options.failApply === true
        ? json({ code: 'self_lockout', reason: 'self_lockout', status: 409 }, 409)
        : json(null, 204);
    }
    if (url.endsWith('/roles')) {
      return options.failRoles === true
        ? json({ code: 'internal_error', status: 500 }, 500)
        : json(roles);
    }

    return json({ status: 'ok' });
  });
};

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('/admin/roles', () => {
  it('is not there at all for somebody who may not read roles', async () => {
    // Not «forbidden»: the same answer the server gives for a resource of another organization, so
    // the screen cannot be used to find out what exists (`ux-architecture.md`, «403 vs 404»).
    await startAt('/admin/roles', []);

    expect(await screen.findByText('errors.not_found.title')).toBeInTheDocument();
    expect(sent.some((request) => request.url.endsWith('/roles'))).toBe(false);
  });

  it('shows the roles as columns and the catalogue as rows', async () => {
    await startAt('/admin/roles?q=task%3Aupdate', [
      'role:read',
      'role:update',
      'task:read',
      'task:update',
    ]);

    expect(
      await screen.findByRole('columnheader', { name: 'Technical writer' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Manager' })).toBeInTheDocument();
    expect(await screen.findByRole('rowheader', { name: /task:update/ })).toBeInTheDocument();
  });

  it('previews before it saves, and saves what the draft assembled', async () => {
    const user = userEvent.setup();

    await startAt('/admin/roles?q=task%3Aupdate', [
      'role:read',
      'role:update',
      'task:read',
      'task:update',
    ]);

    // In `cimode` every label renders as its key, so the two cells of the row share a name — in the
    // product they interpolate the role and the permission and are distinct. The first is the
    // editable role; the second belongs to the system one and is disabled.
    const [editable] = await screen.findAllByRole('checkbox', { name: 'roles.cell.label' });

    await user.click(editable as HTMLElement);

    // Nothing has been written: a click is a draft, and the bar is what says so.
    expect(sent.some((request) => request.url.endsWith('/roles/apply-changes'))).toBe(false);
    await user.click(await screen.findByRole('button', { name: 'roles.draft.review' }));

    const summary = await screen.findByRole('dialog');

    expect(within(summary).getByText(/roles.preview.holders/)).toBeInTheDocument();
    await user.click(within(summary).getByRole('button', { name: 'roles.preview.confirm' }));

    await waitFor(() => {
      expect(sent.some((request) => request.url.endsWith('/roles/apply-changes'))).toBe(true);
    });

    const save = sent.find((request) => request.url.endsWith('/roles/apply-changes'));

    // The whole composition of the one role that moved — not a delta, and not the untouched role.
    expect(save?.body).toEqual({
      changes: [{ roleId: ROLE, permissions: ['task:read', 'task:update'] }],
    });
  });

  it('keeps the filters in the URL, so the view survives a reload and a link', async () => {
    const user = userEvent.setup();
    // Starting narrow: the point here is the URL round-trip, and typing into the unfiltered matrix
    // would be measuring how fast jsdom renders three hundred rows per keystroke.
    const { router } = await startAt('/admin/roles?q=task%3Aupdat', EDITOR);

    await screen.findByRole('columnheader', { name: 'Technical writer' });
    await user.type(screen.getByLabelText('roles.searchLabel'), 'e');

    // Debounced in the handler: the URL catches up once, not once per keystroke.
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ q: 'task:update' });
    });

    await user.click(screen.getByLabelText('roles.onlyDifferences'));

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ diff: true });
    });
  });

  it('collapses a domain into the URL rather than into component state', async () => {
    const user = userEvent.setup();
    const { router } = await startAt('/admin/roles?q=task%3Aupdate', EDITOR);

    await user.click(await screen.findByRole('button', { expanded: true }));

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ collapsed: ['task'] });
    });
    expect(screen.queryByRole('rowheader', { name: /task:update/ })).not.toBeInTheDocument();
  });

  it('lets the draft be thrown away without asking the server', async () => {
    const user = userEvent.setup();

    await startAt('/admin/roles?q=task%3Aupdate', EDITOR);

    const [editable] = await screen.findAllByRole('checkbox', { name: 'roles.cell.label' });

    await user.click(editable as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'roles.draft.discard' }));

    expect(screen.queryByRole('region', { name: 'roles.draft.region' })).not.toBeInTheDocument();
    expect(sent.some((request) => request.method === 'POST')).toBe(false);
  });

  it('repeats the save with the confirmation once a dangerous key is on its way in', async () => {
    const user = userEvent.setup();

    await startAt('/admin/roles?q=user%3Aimpersonate', EDITOR, { dangerous: true });

    const [editable] = await screen.findAllByRole('checkbox', { name: 'roles.cell.label' });

    await user.click(editable as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'roles.draft.review' }));

    const summary = await screen.findByRole('dialog');

    expect(within(summary).getByText('roles.preview.dangerousBody')).toBeInTheDocument();
    await user.click(within(summary).getByRole('button', { name: 'roles.preview.confirm' }));

    await waitFor(() => {
      expect(sent.find((request) => request.url.endsWith('/roles/apply-changes'))?.confirmed).toBe(
        '1',
      );
    });
  });

  it('keeps the draft when the server refuses the save', async () => {
    // The work is the person's, and a refusal is a reason to fix one cell — not to lose eleven.
    const user = userEvent.setup();

    await startAt('/admin/roles?q=task%3Aupdate', EDITOR, { failApply: true });

    const [editable] = await screen.findAllByRole('checkbox', { name: 'roles.cell.label' });

    await user.click(editable as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'roles.draft.review' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'roles.preview.confirm',
      }),
    );

    await waitFor(() => {
      expect(sent.some((request) => request.url.endsWith('/roles/apply-changes'))).toBe(true);
    });
    expect(await screen.findByRole('region', { name: 'roles.draft.region' })).toBeInTheDocument();
  });

  it('expands a domain again, and the URL follows both ways', async () => {
    const user = userEvent.setup();
    const { router } = await startAt('/admin/roles?q=task%3Aupdate', EDITOR);

    const group = await screen.findByRole('button', { expanded: true });

    await user.click(group);
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ collapsed: ['task'] });
    });

    await user.click(await screen.findByRole('button', { expanded: false }));
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ collapsed: [] });
    });
    expect(await screen.findByRole('rowheader', { name: /task:update/ })).toBeInTheDocument();
  });

  it('offers a way back when the roles cannot be loaded', async () => {
    const user = userEvent.setup();

    await startAt('/admin/roles', EDITOR, { failRoles: true });

    // The query client retries once before it gives up, so the error state is two round trips away.
    expect(
      await screen.findByText('roles.loadFailed', undefined, { timeout: 5_000 }),
    ).toBeInTheDocument();

    const before = sent.filter((request) => request.url.endsWith('/roles')).length;

    await user.click(screen.getByRole('button', { name: 'common.retry' }));

    await waitFor(() => {
      expect(sent.filter((request) => request.url.endsWith('/roles')).length).toBeGreaterThan(
        before,
      );
    });
  });

  it('asks before a navigation throws the draft away', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn().mockReturnValue(false);

    vi.stubGlobal('confirm', confirm);

    const { router } = await startAt('/admin/roles?q=task%3Aupdate', EDITOR);

    const [editable] = await screen.findAllByRole('checkbox', { name: 'roles.cell.label' });

    await user.click(editable as HTMLElement);
    // Not awaited: a blocked navigation never settles, which is the router saying «I did not go».
    void router.navigate({ to: '/dashboard' });

    // Refused, so the person keeps both the draft and the screen it belongs to.
    await waitFor(() => {
      expect(confirm).toHaveBeenCalledTimes(1);
    });
    expect(router.state.location.pathname).toBe('/admin/roles');

    // And accepted, it lets go.
    confirm.mockReturnValue(true);
    await router.navigate({ to: '/dashboard' });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/dashboard');
    });
  });

  it('reads «?diff=no» as off, which is what it says', async () => {
    // `z.coerce.boolean()` answers `true` to every non-empty string, so this URL used to turn the
    // filter on — the opposite of what somebody typing it meant.
    await startAt('/admin/roles?q=task%3Aupdate&diff=no', EDITOR);

    expect(await screen.findByLabelText('roles.onlyDifferences')).not.toBeChecked();
  });

  it('survives a hand-edited URL instead of replacing itself with an error', async () => {
    // A search string past the limit and a domain that does not exist. Each falls back inside the
    // schema: `validateSearch` throwing here would swap the screen for the error boundary, and with
    // `replace: true` on every filter change the broken address would stay in the bar.
    await startAt(`/admin/roles?q=${'x'.repeat(200)}&collapsed=nonesuch&diff=maybe`, EDITOR);

    expect(
      await screen.findByRole('columnheader', { name: 'Technical writer' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('roles.onlyDifferences')).not.toBeChecked();
  });
});
