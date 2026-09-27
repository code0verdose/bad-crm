import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

import { type i18n as I18n } from 'i18next';

import { SharedI18n } from '@shared';

import { axeViolationsIn } from '../support/axe-scan.util.js';
import {
  expectFocusInside,
  expectFocusReturnedTo,
  focusEscapes,
  tabWrapFailures,
} from '../support/focus-trap.util.js';

/**
 * `/projects/$projectId/settings` and `/projects/$projectId/members` — the client halves of
 * STORY-014-01 and STORY-014-02, and the client half of STORY-014-05 acceptance 5: **every control
 * is drawn from the card's `permissions` block**, each flag proven in both of its values.
 *
 * Mounted as the whole application — real router, real guards, real query client with its global
 * `MutationCache` toast — because «one signal per action» and «focus back on the trigger» are
 * properties of the assembled screen, not of a component on a stand.
 */

let cases = 0;
let PROJECT = '';

const nextProjectId = (): string => {
  cases += 1;

  return `018f4a3b-2c1d-7a41-9f00-${String(cases).padStart(12, '0')}`;
};

const ME = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b10';
const LEAD = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b11';
const MEMBER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b12';
const OUTSIDER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b13';
const ORGANIZATION = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b99';

interface Flags {
  readonly canEdit: boolean;
  readonly canManageMembers: boolean;
  readonly canArchive: boolean;
  readonly canDelete: boolean;
}

const NONE: Flags = {
  canEdit: false,
  canManageMembers: false,
  canArchive: false,
  canDelete: false,
};
const ALL: Flags = { canEdit: true, canManageMembers: true, canArchive: true, canDelete: true };

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Headers;
}

let sent: Call[] = [];

const platformFetch = globalThis.fetch;

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const noContent = (): Response => new Response(null, { status: 204 });

const problem = (status: number, code: string, extra: Record<string, unknown> = {}): Response =>
  new Response(
    JSON.stringify({ type: 'about:blank', title: 'x', status, code, requestId: 'r', ...extra }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

const card = (permissions: Flags, overrides: Record<string, unknown> = {}) => ({
  id: PROJECT,
  key: 'BAD',
  name: 'Bad CRM',
  description: 'One tool instead of six.',
  status: 'ACTIVE',
  visibility: 'PUBLIC_ORG',
  leadId: LEAD,
  color: 'brand',
  memberCount: 2,
  startedAt: '2026-09-01T00:00:00.000Z',
  dueAt: '2026-12-01T00:00:00.000Z',
  taskCounter: 0,
  createdAt: '2026-08-30T00:00:00.000Z',
  permissions,
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

const PEOPLE = [
  person(ME, 'Mila', 'Reader'),
  person(LEAD, 'Anna', 'Ivanova'),
  person(MEMBER, 'Oleg', 'Petrov'),
  person(OUTSIDER, 'Vera', 'Sidorova'),
];

type Handler = (call: Call) => Response | Promise<Response>;

interface ServerOptions {
  readonly granted?: readonly string[];
  readonly flags?: Flags;
  readonly overrides?: Record<string, unknown>;
  /** Answers every write, by method and path suffix. `noContent` unless said otherwise. */
  readonly write?: Handler;
  /**
   * Every roster read after the first write never answers. A rollback test needs it: the mutation
   * invalidates on settle, and a refetch that restored the row would make a missing rollback look
   * like a working one.
   */
  readonly holdRosterRefetch?: boolean;
  /** Who the directory answers with. The four people above unless said otherwise. */
  readonly people?: readonly ReturnType<typeof person>[];
}

const stubServer = ({
  granted = ['project:read', 'project:create', 'project:manage_visibility', 'user:read'],
  flags = ALL,
  overrides = {},
  write = () => noContent(),
  holdRosterRefetch = false,
  people = PEOPLE,
}: ServerOptions): void => {
  const log: Call[] = [];
  let wrote = false;
  let roster = [membership(MEMBER, 'MEMBER', 60), membership(LEAD, 'LEAD', 40)];

  sent = log;

  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url).pathname;
    const text = input.method === 'GET' ? '' : await input.clone().text();
    const call: Call = {
      url,
      method: input.method,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
      headers: input.headers,
    };

    log.push(call);

    if (url.endsWith('/auth/refresh')) {
      return json({
        status: 'authenticated',
        accessToken: 'access-token',
        tokenType: 'Bearer',
        expiresIn: 900,
        user: { id: ME, email: 'reader@example.test', locale: 'en', timezone: 'UTC' },
        organization: { id: ORGANIZATION, name: 'Org', slug: 'org' },
      });
    }
    if (url.endsWith('/me/permissions')) {
      return json({ permissions: granted, denied: [], roles: [], isOwner: false, version: 1 });
    }
    if (url.endsWith('/employees')) {
      return json({
        items: people,
        total: people.length,
        page: 1,
        perPage: 100,
        sort: 'name',
        facets: { roles: [], teams: [] },
      });
    }
    if (input.method !== 'GET') {
      wrote = true;

      const answer = await write(call);

      // A removal the server accepted is gone from the next read, as it would be.
      if (answer.status === 204 && input.method === 'DELETE' && url.includes('/members/')) {
        roster = roster.filter((row) => !url.endsWith(row.userId));
      }

      return answer;
    }
    if (url.endsWith(`/projects/${PROJECT}/members`)) {
      // Counted from the write, not from the first read: StrictMode and a slow suite can ask for
      // the roster more than once before anything has been changed.
      return holdRosterRefetch && wrote
        ? new Promise<Response>(() => undefined)
        : json({ items: roster });
    }
    if (url.endsWith(`/projects/${PROJECT}`)) return json(card(flags, overrides));

    return json({ status: 'ok' });
  });
};

interface MountOptions extends ServerOptions {
  readonly section?: 'settings' | 'members' | '';
  readonly path?: string;
  readonly i18n?: I18n;
  readonly language?: string;
}

const startAt = async ({
  section = 'settings',
  path,
  i18n,
  language,
  ...options
}: MountOptions = {}) => {
  vi.resetModules();
  PROJECT = nextProjectId();
  stubServer(options);

  const { renderApp } = await import('../support/render-app.util.js');

  return renderApp({
    path: path ?? `/projects/${PROJECT}${section === '' ? '' : `/${section}`}`,
    status: 'authenticated',
    ...(i18n === undefined ? {} : { i18n }),
    ...(language === undefined ? {} : { language }),
  });
};

/** The project writes — the session's own `POST /auth/refresh` is not one of them. */
const writes = (method: string) =>
  sent.filter((call) => call.method === method && call.url.includes('/projects'));

/** A second mount in one case: the first tree is unmounted, so no query can find it. */
const remount = async (options: MountOptions) => {
  cleanup();

  return startAt(options);
};

/** The row of the roster that names this person. */
const rowOf = (table: HTMLElement, name: string): HTMLElement => {
  const row = within(table)
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByText(name) !== null);

  if (row === undefined) throw new Error(`no row names ${name}`);

  return row;
};

/** The project card has loaded and its head is on screen. */
const cardReady = () => screen.findByRole('heading', { level: 2, name: 'Bad CRM' });

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('the settings section — every control from the permissions block', () => {
  it('draws the edit form only for canEdit', async () => {
    await startAt({ flags: { ...NONE, canEdit: true } });
    expect(
      await screen.findByRole('button', { name: 'projects.settings.edit.submit' }),
    ).toBeEnabled();

    await remount({ flags: { ...NONE, canArchive: true } });
    await screen.findByRole('button', { name: 'projects.archive.action' });
    expect(screen.queryByRole('button', { name: 'projects.settings.edit.submit' })).toBeNull();
  });

  it('draws the archive button only for canArchive', async () => {
    await startAt({ flags: { ...NONE, canArchive: true } });
    expect(await screen.findByRole('button', { name: 'projects.archive.action' })).toBeEnabled();

    await remount({ flags: { ...NONE, canDelete: true } });
    await screen.findByRole('button', { name: 'projects.delete.action' });
    expect(screen.queryByRole('button', { name: 'projects.archive.action' })).toBeNull();
  });

  it('draws the delete button only for canDelete', async () => {
    await startAt({ flags: { ...NONE, canDelete: true } });
    expect(await screen.findByRole('button', { name: 'projects.delete.action' })).toBeEnabled();

    await remount({ flags: { ...NONE, canArchive: true } });
    await screen.findByRole('button', { name: 'projects.archive.action' });
    expect(screen.queryByRole('button', { name: 'projects.delete.action' })).toBeNull();
  });

  it('offers the whole directory as the lead only for canManageMembers, the current lead otherwise', async () => {
    await startAt({ flags: { ...NONE, canEdit: true } });

    const locked = await screen.findByLabelText(/projects\.field\.lead/, { selector: 'select' });

    await waitFor(() => {
      expect(
        within(locked)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['projects.field.leadChoose', 'Anna Ivanova']);
    });

    await remount({ flags: { ...NONE, canEdit: true, canManageMembers: true } });

    const open = await screen.findByLabelText(/projects\.field\.lead/, { selector: 'select' });

    await waitFor(() => {
      expect(within(open).getAllByRole('option')).toHaveLength(PEOPLE.length + 1);
    });
  });

  it('hides the settings tab for a reader the block opens nothing to, and says so on a pasted link', async () => {
    await startAt({ flags: NONE, granted: ['project:read'] });

    expect(await screen.findByText('projects.settings.nothing')).toBeInTheDocument();

    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');

    expect(tabs.map((tab) => tab.textContent)).not.toContain('projects.section.settings');
  });

  it('does not decide from the role: an admin-like capability set with an all-false block shows nothing', async () => {
    await startAt({
      flags: NONE,
      granted: ['project:read', 'project:update', 'project:archive', 'project:delete'],
    });

    expect(await screen.findByText('projects.settings.nothing')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'projects.archive.action' })).toBeNull();
  });

  it('keeps the controls of an archived project on screen, disabled', async () => {
    await startAt({ overrides: { status: 'ARCHIVED' } });

    expect(
      await screen.findByRole('button', { name: 'projects.settings.edit.submit' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'projects.archive.action' })).toBeDisabled();
    expect(screen.getByText('projects.archived.title')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = await startAt();

    await screen.findByRole('button', { name: 'projects.settings.edit.submit' });

    expect(await axeViolationsIn(container, { control: 'aria-allowed-attr' })).toEqual([]);
  });
});

describe('editing the project', () => {
  const submit = async (user: UserEvent) => {
    await user.click(await screen.findByRole('button', { name: 'projects.settings.edit.submit' }));
  };

  it('refuses a deadline before the start under the deadline, and sends nothing', async () => {
    const user = userEvent.setup();

    await startAt();

    const due = await screen.findByLabelText('projects.field.dueAt');

    await user.clear(due);
    await user.type(due, '2026-08-01');
    await submit(user);

    await waitFor(() => {
      expect(due).toHaveAttribute('aria-invalid', 'true');
    });
    expect(screen.getByText('projects.field.dueBeforeStart')).toBeInTheDocument();
    expect(writes('PATCH')).toEqual([]);
  });

  it('sends the whole project as a PATCH, dates as UTC instants, and says so once', async () => {
    const user = userEvent.setup();

    await startAt();

    const name = await screen.findByLabelText(/projects\.field\.name/);

    await user.clear(name);
    await user.type(name, '  Better CRM ');
    await submit(user);

    await waitFor(() => {
      expect(writes('PATCH')).toHaveLength(1);
    });
    expect(writes('PATCH')[0]?.body).toEqual({
      name: 'Better CRM',
      description: 'One tool instead of six.',
      leadId: LEAD,
      color: 'brand',
      startedAt: '2026-09-01T00:00:00.000Z',
      dueAt: '2026-12-01T00:00:00.000Z',
    });
    expect(await screen.findByText('projects.saved')).toBeInTheDocument();
  });

  it('puts a server refusal about the lead under the lead, and raises no toast', async () => {
    const user = userEvent.setup();

    await startAt({
      write: () => problem(403, 'user_forbidden', { reason: 'self_assignment_forbidden' }),
    });

    await submit(user);

    const lead = await screen.findByLabelText(/projects\.field\.lead/, { selector: 'select' });

    await waitFor(() => {
      expect(lead).toHaveAttribute('aria-invalid', 'true');
    });
    expect(screen.getAllByText('projects.field.leadSelf')).toHaveLength(1);
    expect(screen.queryByText('errors.code.user_forbidden')).toBeNull();
  });

  it('puts a 422 issue under its field', async () => {
    const user = userEvent.setup();

    await startAt({
      write: () =>
        problem(422, 'validation_failed', {
          errors: [{ path: 'name', code: 'too_big', message: 'x' }],
        }),
    });

    await submit(user);

    expect(await screen.findByText('errors.field.too_big')).toBeInTheDocument();
    expect(screen.getByLabelText(/projects\.field\.name/)).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('changing the visibility', () => {
  it('confirms first, then sends the change with the confirmation header', async () => {
    const user = userEvent.setup();

    await startAt();

    await user.click(
      await screen.findByRole('button', { name: /projects\.settings\.visibility\.change/ }),
    );

    const dialog = await screen.findByRole('dialog');

    expect(writes('POST')).toEqual([]);
    expect(
      within(dialog).getByText('projects.visibility.close.consequence.access'),
    ).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole('button', { name: 'projects.visibility.close.confirm' }),
    );

    await waitFor(() => {
      expect(writes('POST')).toHaveLength(1);
    });
    expect(writes('POST')[0]?.url).toMatch(/\/visibility$/);
    expect(writes('POST')[0]?.body).toEqual({ visibility: 'PRIVATE' });
    expect(writes('POST')[0]?.headers.get('X-Confirm-Dangerous')).toBe('1');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('is offered by the capability, for want of a flag in the contract', async () => {
    await startAt({ flags: ALL, granted: ['project:read', 'user:read'] });

    await screen.findByRole('button', { name: 'projects.archive.action' });
    expect(
      screen.queryByRole('button', { name: /projects\.settings\.visibility\.change/ }),
    ).toBeNull();
  });
});

describe('archiving the project — the confirmation dialog', () => {
  const openArchive = async (user: UserEvent): Promise<HTMLElement> => {
    await user.click(await screen.findByRole('button', { name: 'projects.archive.action' }));

    return screen.findByRole('dialog');
  };

  it('lists what it does above the button that does it', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openArchive(user);
    const consequence = within(dialog).getByText('projects.archive.consequence.readOnly');
    const confirm = within(dialog).getByRole('button', { name: 'projects.archive.confirm' });

    expect(
      consequence.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('opens with the focus on a control that cancels', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openArchive(user);

    await waitFor(() => {
      expect(expectFocusInside(dialog)).toHaveAccessibleName('projects.confirm.cancel');
    });
  });

  it('keeps the focus inside itself, in both directions', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openArchive(user);

    expect(
      await focusEscapes(user, dialog, await screen.findByLabelText(/projects\.field\.name/)),
    ).toEqual([]);
  });

  it('wraps at both ends rather than swallowing the key', async () => {
    const user = userEvent.setup();

    await startAt();

    expect(await tabWrapFailures(user, await openArchive(user))).toEqual([]);
  });

  it('cancels on Escape without archiving anything, and gives the focus back to the trigger', async () => {
    const user = userEvent.setup();

    await startAt();

    const trigger = await screen.findByRole('button', { name: 'projects.archive.action' });

    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expectFocusReturnedTo(trigger, 'the archive button');
    });
    expect(writes('POST')).toEqual([]);
  });

  it('shows a refusal inside the dialog in the words of its reason, and no toast', async () => {
    const user = userEvent.setup();

    await startAt({
      write: () => problem(403, 'user_forbidden', { reason: 'insufficient_acl_level' }),
    });

    const dialog = await openArchive(user);

    await user.click(within(dialog).getByRole('button', { name: 'projects.archive.confirm' }));

    const alert = await within(dialog).findByRole('alert');

    expect(alert).toHaveTextContent('projects.refusal.insufficientLevel');
    expect(screen.getAllByText('projects.refusal.insufficientLevel')).toHaveLength(1);
    // The global toast stands aside: it would say the collapsed code, outside the modal.
    expect(screen.queryByText('errors.code.user_forbidden')).toBeNull();
  });

  it('archives on confirm, closes, and says so', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openArchive(user);

    await user.click(within(dialog).getByRole('button', { name: 'projects.archive.confirm' }));

    await waitFor(() => {
      expect(writes('POST').map((call) => call.url)).toEqual([
        `/api/v1/projects/${PROJECT}/archive`,
      ]);
    });
    expect(await screen.findByText('projects.archive.done')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

describe('deleting the project', () => {
  it('deletes on confirm and leaves the card, without re-reading the project it just deleted', async () => {
    const user = userEvent.setup();

    const { router } = await startAt();

    await user.click(await screen.findByRole('button', { name: 'projects.delete.action' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'projects.delete.confirm',
      }),
    );

    await waitFor(() => {
      // `/` is the dashboard's address: the index route redirects there.
      expect(router.state.location.pathname).toBe('/dashboard');
    });
    expect(writes('DELETE').map((call) => call.url)).toEqual([`/api/v1/projects/${PROJECT}`]);

    const deletedAt = sent.findIndex((call) => call.method === 'DELETE');

    expect(
      sent.slice(deletedAt + 1).filter((call) => call.url === `/api/v1/projects/${PROJECT}`),
    ).toEqual([]);
  });
});

describe('the members section', () => {
  const roster = async () => {
    const table = await screen.findByRole('table');

    await within(table).findByText('Oleg Petrov');

    return table;
  };

  it('is read-only without canManageMembers: no add form, no role select, no remove', async () => {
    await startAt({ section: 'members', flags: { ...ALL, canManageMembers: false } });

    const table = await roster();

    expect(within(table).queryAllByRole('combobox')).toEqual([]);
    expect(within(table).queryAllByRole('button')).toEqual([]);
    expect(screen.queryByRole('button', { name: 'projects.members.add.submit' })).toBeNull();
  });

  it('draws the add form, a role select and a remove button per row with canManageMembers', async () => {
    await startAt({ section: 'members', flags: { ...NONE, canManageMembers: true } });

    const table = await roster();

    expect(within(table).getAllByRole('combobox')).toHaveLength(2);
    expect(
      within(table).getAllByRole('button', { name: 'projects.members.removeOf' }),
    ).toHaveLength(2);
    expect(
      await screen.findByRole('button', { name: 'projects.members.add.submit' }),
    ).toBeDisabled();
  });

  it('offers only people who are not on the project and not the reader', async () => {
    await startAt({ section: 'members' });

    await roster();

    const person = await screen.findByLabelText('projects.members.add.person');

    await waitFor(() => {
      expect(
        within(person)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['projects.members.add.choose', 'Vera Sidorova']);
    });
  });

  it('adds somebody with the role and share chosen, pessimistically, with one toast', async () => {
    const user = userEvent.setup();

    await startAt({ section: 'members' });

    await roster();
    await user.selectOptions(await screen.findByLabelText('projects.members.add.person'), OUTSIDER);
    await user.selectOptions(screen.getByLabelText('projects.members.add.role'), 'REVIEWER');
    await user.click(screen.getByRole('button', { name: 'projects.members.add.submit' }));

    await waitFor(() => {
      expect(writes('POST')).toHaveLength(1);
    });
    expect(writes('POST')[0]?.body).toEqual({
      userId: OUTSIDER,
      projectRole: 'REVIEWER',
      allocationPct: 100,
    });
    const [added] = writes('POST');

    assert(added !== undefined, 'the add request was not sent');
    expect(added.headers.get('Idempotency-Key')).toMatch(/\S/);
    expect(await screen.findAllByText('projects.members.added')).toHaveLength(1);
  });

  it('changes a role at once, and takes it back — with one toast — when the server refuses', async () => {
    const user = userEvent.setup();
    let answer: (response: Response) => void = () => undefined;

    await startAt({
      section: 'members',
      holdRosterRefetch: true,
      write: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });

    const table = await roster();
    const leadRole = within(rowOf(table, 'Anna Ivanova')).getByRole('combobox');

    expect(leadRole).toHaveValue('LEAD');
    await user.selectOptions(leadRole, 'MEMBER');

    // Optimistic: the row says MEMBER before the server has said anything.
    expect(within(rowOf(table, 'Anna Ivanova')).getByRole('combobox')).toHaveValue('MEMBER');
    expect(writes('PATCH')[0]?.body).toEqual({ projectRole: 'MEMBER' });

    answer(problem(409, 'last_project_lead_required'));

    await waitFor(() => {
      expect(within(rowOf(table, 'Anna Ivanova')).getByRole('combobox')).toHaveValue('LEAD');
    });
    expect(await screen.findAllByText('errors.code.last_project_lead_required')).toHaveLength(1);
  });

  it('takes a row off at once, and puts it back in its place when the server refuses', async () => {
    const user = userEvent.setup();
    let answer: (response: Response) => void = () => undefined;

    await startAt({
      section: 'members',
      holdRosterRefetch: true,
      write: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });

    const table = await roster();
    const names = () =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getAllByRole('cell')[0]?.textContent);

    expect(names()).toEqual(['Anna Ivanova', 'Oleg Petrov']);

    await user.click(within(rowOf(table, 'Anna Ivanova')).getByRole('button'));

    expect(names()).toEqual(['Oleg Petrov']);

    answer(problem(409, 'last_project_lead_required'));

    await waitFor(() => {
      expect(names()).toEqual(['Anna Ivanova', 'Oleg Petrov']);
    });
    expect(await screen.findAllByText('errors.code.last_project_lead_required')).toHaveLength(1);
  });

  it('keeps a removal the server accepted', async () => {
    const user = userEvent.setup();

    await startAt({ section: 'members' });

    const table = await roster();

    await user.click(within(rowOf(table, 'Oleg Petrov')).getByRole('button'));

    expect(await screen.findByText('projects.members.removed')).toBeInTheDocument();
    expect(writes('DELETE').map((call) => call.url)).toEqual([
      `/api/v1/projects/${PROJECT}/members/${MEMBER}`,
    ]);
    expect(within(table).queryByText('Oleg Petrov')).toBeNull();
  });

  it('switches from the overview to the members tab through the tab list', async () => {
    const user = userEvent.setup();

    const { router } = await startAt({ section: '' });

    await cardReady();
    await user.click(screen.getByRole('tab', { name: 'projects.section.members' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/projects/${PROJECT}/members`);
    });
    expect(screen.getByRole('tab', { name: 'projects.section.members' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

describe('creating a project', () => {
  const fill = async (user: UserEvent, key: string) => {
    // The session answers first: the reader becomes the default lead, and the form starts from that.
    await waitFor(() => {
      expect(screen.getByLabelText(/projects\.field\.lead/, { selector: 'select' })).toHaveValue(
        ME,
      );
    });
    await user.type(await screen.findByLabelText(/projects\.field\.key/), key);
    await user.type(screen.getByLabelText(/projects\.field\.name/), 'Bad CRM');
  };

  it('is refused without project:create, before anything renders', async () => {
    await startAt({ path: '/projects/new', granted: ['project:read'] });

    expect(await screen.findByText('project:create')).toBeInTheDocument();
    expect(screen.queryByLabelText(/projects\.field\.key/)).toBeNull();
  });

  it('refuses a malformed key under the key, and sends nothing', async () => {
    const user = userEvent.setup();

    await startAt({ path: '/projects/new' });

    await fill(user, '1x');
    await user.click(screen.getByRole('button', { name: 'projects.create.submit' }));

    expect(await screen.findByText('projects.field.keyInvalid')).toBeInTheDocument();
    expect(writes('POST')).toEqual([]);
  });

  it('puts a taken key under the key, with no toast', async () => {
    const user = userEvent.setup();

    await startAt({ path: '/projects/new', write: () => problem(409, 'project_already_exists') });

    await fill(user, 'bad');
    await user.click(screen.getByRole('button', { name: 'projects.create.submit' }));

    expect(await screen.findByText('projects.field.keyTaken')).toBeInTheDocument();
    expect(screen.getByLabelText(/projects\.field\.key/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('errors.code.project_already_exists')).toBeNull();
  });

  it('creates it led by the reader, lands on its card without reading it again, and says so', async () => {
    const user = userEvent.setup();
    const created = () => json(card(ALL, { id: PROJECT, key: 'BAD' }), 201);

    const { router } = await startAt({ path: '/projects/new', write: created });

    await fill(user, ' bad ');
    await user.click(screen.getByRole('button', { name: 'projects.create.submit' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/projects/${PROJECT}`);
    });
    expect(writes('POST')[0]?.body).toEqual({
      key: 'bad',
      name: 'Bad CRM',
      description: null,
      visibility: 'PUBLIC_ORG',
      leadId: ME,
      color: 'brand',
      startedAt: null,
      dueAt: null,
    });
    await cardReady();
    expect(await screen.findByText('projects.created')).toBeInTheDocument();
    expect(
      sent.filter((call) => call.method === 'GET' && call.url === `/api/v1/projects/${PROJECT}`),
    ).toEqual([]);
  });
});

describe('the refusals no screen above has shown yet', () => {
  it('opens a private project to the organization, and keeps a refusal inside the dialog', async () => {
    const user = userEvent.setup();

    await startAt({
      overrides: { visibility: 'PRIVATE' },
      write: () => problem(403, 'user_forbidden', { reason: 'insufficient_acl_level' }),
    });

    await user.click(
      await screen.findByRole('button', { name: /projects\.settings\.visibility\.change/ }),
    );

    const dialog = await screen.findByRole('dialog');

    expect(
      within(dialog).getByText('projects.visibility.open.consequence.access'),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole('button', { name: 'projects.visibility.open.confirm' }),
    );

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'projects.refusal.insufficientLevel',
    );
    expect(writes('POST')[0]?.body).toEqual({ visibility: 'PUBLIC_ORG' });
    expect(screen.queryByText('errors.code.user_forbidden')).toBeNull();
  });

  it('keeps a refused deletion inside the dialog, and stays on the card', async () => {
    const user = userEvent.setup();

    const { router } = await startAt({
      write: () => problem(403, 'user_forbidden', { reason: 'permission_not_granted' }),
    });

    await user.click(await screen.findByRole('button', { name: 'projects.delete.action' }));

    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'projects.delete.confirm' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'projects.refusal.permissionNotGranted',
    );
    expect(router.state.location.pathname).toBe(`/projects/${PROJECT}/settings`);
  });

  it('says in one toast why an add was refused, in the words of its reason', async () => {
    const user = userEvent.setup();

    await startAt({
      section: 'members',
      write: () => problem(403, 'user_forbidden', { reason: 'self_assignment_forbidden' }),
    });

    await screen.findByRole('table');
    await user.selectOptions(await screen.findByLabelText('projects.members.add.person'), OUTSIDER);
    await user.click(screen.getByRole('button', { name: 'projects.members.add.submit' }));

    expect(await screen.findAllByText('projects.refusal.selfAssignment')).toHaveLength(1);
    expect(screen.queryByText('errors.code.user_forbidden')).toBeNull();
  });

  it('sends the share of time typed into the form', async () => {
    const user = userEvent.setup();

    await startAt({ section: 'members' });

    await screen.findByRole('table');
    await user.selectOptions(await screen.findByLabelText('projects.members.add.person'), OUTSIDER);

    const share = screen.getByLabelText('projects.members.add.allocation');

    await user.clear(share);
    await user.type(share, '40');
    await user.click(screen.getByRole('button', { name: 'projects.members.add.submit' }));

    await waitFor(() => {
      expect(writes('POST')[0]?.body).toEqual({
        userId: OUTSIDER,
        projectRole: 'MEMBER',
        allocationPct: 40,
      });
    });
  });

  it('says so instead of offering an empty picker when everybody is already on the project', async () => {
    await startAt({ section: 'members', people: PEOPLE.slice(0, 3) });

    expect(await screen.findByText('projects.members.add.none')).toBeInTheDocument();
    expect(screen.queryByLabelText('projects.members.add.person')).toBeNull();
  });

  it('confirms a role change the server accepted', async () => {
    const user = userEvent.setup();

    await startAt({ section: 'members' });

    const table = await screen.findByRole('table');

    await within(table).findByText('Oleg Petrov');
    await user.selectOptions(within(rowOf(table, 'Oleg Petrov')).getByRole('combobox'), 'REVIEWER');

    expect(await screen.findByText('projects.members.updated')).toBeInTheDocument();
    expect(writes('PATCH').map((call) => call.url)).toEqual([
      `/api/v1/projects/${PROJECT}/members/${MEMBER}`,
    ]);
  });

  it('moves between every shipped section through the tab list', async () => {
    const user = userEvent.setup();

    const { router } = await startAt({ section: 'members' });

    await cardReady();
    await user.click(screen.getByRole('tab', { name: 'projects.section.settings' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/projects/${PROJECT}/settings`);
    });

    await user.click(screen.getByRole('tab', { name: 'projects.section.overview' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/projects/${PROJECT}`);
    });
  });
});

describe('creating a project — what the form says above its fields', () => {
  const submitNew = async (user: UserEvent) => {
    await waitFor(() => {
      expect(screen.getByLabelText(/projects\.field\.lead/, { selector: 'select' })).toHaveValue(
        ME,
      );
    });
    await user.type(await screen.findByLabelText(/projects\.field\.key/), 'BAD');
    await user.type(screen.getByLabelText(/projects\.field\.name/), 'Bad CRM');
    await user.click(screen.getByRole('button', { name: 'projects.create.submit' }));
  };

  it('shows a failure about the request as one alert above the form', async () => {
    const user = userEvent.setup();

    await startAt({ path: '/projects/new', write: () => problem(500, 'internal_error') });

    await submitNew(user);

    expect(await screen.findAllByText('errors.code.internal_error')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('errors.code.internal_error');
  });

  it('keeps the seconds of a rate limit in that alert', async () => {
    const user = userEvent.setup();
    const limited = () =>
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'x',
          status: 429,
          code: 'rate_limited',
          requestId: 'r',
        }),
        {
          status: 429,
          headers: { 'content-type': 'application/problem+json', 'retry-after': '30' },
        },
      );

    await startAt({ path: '/projects/new', write: limited });

    await submitNew(user);

    expect(await screen.findByText('errors.code.rate_limited')).toBeInTheDocument();
  });

  it('offers the reader alone as the lead when they may not see the directory', async () => {
    await startAt({ path: '/projects/new', granted: ['project:read', 'project:create'] });

    // Re-read inside the wait: the form is keyed by the reader and remounts once the session answers.
    const lead = () => screen.getByLabelText(/projects\.field\.lead/, { selector: 'select' });

    await waitFor(() => {
      expect(lead()).toHaveValue(ME);
    });
    expect(
      within(lead())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['projects.field.leadChoose', 'projects.field.leadYou']);
  });
});

/**
 * The sentences `cimode` cannot state: the confirmation names the project and a role select names
 * the person, both with the real catalogues — a placeholder left in a label is a key renamed on one
 * side only.
 */
describe.each(['en', 'ru'] as const)('the interpolated labels in %s', (language) => {
  it('name the project the delete dialog is about', async () => {
    const i18n = SharedI18n.createI18n(language);
    const user = userEvent.setup();

    await startAt({ i18n, language });

    await user.click(await screen.findByRole('button', { name: i18n.t('projects.delete.action') }));

    const dialog = within(await screen.findByRole('dialog'));

    expect(dialog.getByText(/Bad CRM/)).toBeInTheDocument();
    expect(dialog.queryByText(/\{\{/)).toBeNull();
    expect(
      dialog.getAllByRole('button', { name: i18n.t('projects.confirm.cancel') }).length,
    ).toBeGreaterThan(0);
  });

  it('name the person a role select and a remove button are about', async () => {
    const i18n = SharedI18n.createI18n(language);

    await startAt({ section: 'members', i18n, language });

    const table = await screen.findByRole('table');
    const select = await within(table).findByRole('combobox', { name: /Oleg Petrov/ });
    const remove = within(table).getByRole('button', { name: /Oleg Petrov/ });

    expect(select.getAttribute('aria-label') ?? '').not.toMatch(/\{\{|projects\./);
    expect(remove.getAttribute('aria-label') ?? '').not.toMatch(/\{\{|projects\./);
  });
});
