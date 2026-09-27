import { cleanup, screen, within } from '@testing-library/react';
import { vi } from 'vitest';

import { type i18n as I18n } from 'i18next';

/**
 * The stand the project screens are mounted on — `/projects/new`, and the settings and members
 * sections of a card: a stubbed server answering the session, the capability set, the directory,
 * the card and its roster, and recording every call the screen makes.
 *
 * One stand for the three screen suites, because they are one surface: the card the create page
 * lands on is the card the settings and members sections read, and three copies of its shape would
 * drift apart the first time the contract adds a field.
 *
 * `PROJECT` and `sent` are live bindings: each mount takes a fresh project id — a query cached by
 * the case before cannot answer for this one — and the log of calls the new mount makes.
 */

let cases = 0;

export let PROJECT = '';

const nextProjectId = (): string => {
  cases += 1;

  return `018f4a3b-2c1d-7a41-9f00-${String(cases).padStart(12, '0')}`;
};

export const ME = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b10';
export const LEAD = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b11';
export const MEMBER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b12';
export const OUTSIDER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b13';
const ORGANIZATION = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b99';

export interface Flags {
  readonly canEdit: boolean;
  readonly canManageMembers: boolean;
  readonly canArchive: boolean;
  readonly canDelete: boolean;
}

export const NONE: Flags = {
  canEdit: false,
  canManageMembers: false,
  canArchive: false,
  canDelete: false,
};
export const ALL: Flags = {
  canEdit: true,
  canManageMembers: true,
  canArchive: true,
  canDelete: true,
};

export interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Headers;
}

export let sent: Call[] = [];

export const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const noContent = (): Response => new Response(null, { status: 204 });

export const problem = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
): Response =>
  new Response(
    JSON.stringify({ type: 'about:blank', title: 'x', status, code, requestId: 'r', ...extra }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

export const card = (permissions: Flags, overrides: Record<string, unknown> = {}) => ({
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

export const PEOPLE = [
  person(ME, 'Mila', 'Reader'),
  person(LEAD, 'Anna', 'Ivanova'),
  person(MEMBER, 'Oleg', 'Petrov'),
  person(OUTSIDER, 'Vera', 'Sidorova'),
];

type Handler = (call: Call) => Response | Promise<Response>;

export interface ServerOptions {
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
  /** Also on the project, beside the lead and the member — as members, full time. */
  readonly alsoOnProject?: readonly string[];
}

const stubServer = ({
  granted = ['project:read', 'project:create', 'project:manage_visibility', 'user:read'],
  flags = ALL,
  overrides = {},
  write = () => noContent(),
  holdRosterRefetch = false,
  people = PEOPLE,
  alsoOnProject = [],
}: ServerOptions): void => {
  const log: Call[] = [];
  let wrote = false;
  let roster = [
    membership(MEMBER, 'MEMBER', 60),
    membership(LEAD, 'LEAD', 40),
    ...alsoOnProject.map((userId) => membership(userId, 'MEMBER', 100)),
  ];

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

      // What the server accepted is in the next read, as it would be.
      if (answer.status === 204 && input.method === 'DELETE' && url.includes('/members/')) {
        roster = roster.filter((row) => !url.endsWith(row.userId));
      }
      if (answer.status === 204 && input.method === 'POST' && url.endsWith('/members')) {
        const draft = call.body as { userId: string; projectRole: string; allocationPct: number };

        roster = [...roster, membership(draft.userId, draft.projectRole, draft.allocationPct)];
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

export interface MountOptions extends ServerOptions {
  readonly section?: 'settings' | 'members' | '';
  readonly path?: string;
  readonly i18n?: I18n;
  readonly language?: string;
}

export const startAt = async ({
  section = 'settings',
  path,
  i18n,
  language,
  ...options
}: MountOptions = {}) => {
  vi.resetModules();
  PROJECT = nextProjectId();
  stubServer(options);

  const { renderApp } = await import('./render-app.util.js');

  return renderApp({
    path: path ?? `/projects/${PROJECT}${section === '' ? '' : `/${section}`}`,
    status: 'authenticated',
    ...(i18n === undefined ? {} : { i18n }),
    ...(language === undefined ? {} : { language }),
  });
};

/** The project writes — the session's own `POST /auth/refresh` is not one of them. */
export const writes = (method: string) =>
  sent.filter((call) => call.method === method && call.url.includes('/projects'));

/** A second mount in one case: the first tree is unmounted, so no query can find it. */
export const remount = async (options: MountOptions) => {
  cleanup();

  return startAt(options);
};

/** The row of the roster that names this person. */
export const rowOf = (table: HTMLElement, name: string): HTMLElement => {
  const row = within(table)
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByText(name) !== null);

  if (row === undefined) throw new Error(`no row names ${name}`);

  return row;
};

/** The project card has loaded and its head is on screen. */
export const cardReady = () => screen.findByRole('heading', { level: 2, name: 'Bad CRM' });

/** The roster table, once the directory has named its people. */
export const roster = async (): Promise<HTMLElement> => {
  const table = await screen.findByRole('table');

  await within(table).findByText('Oleg Petrov');

  return table;
};
