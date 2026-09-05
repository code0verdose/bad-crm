import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type i18n as I18n } from 'i18next';

import { SharedI18n } from '@shared';

import {
  expectFocusInside,
  expectFocusReturnedTo,
  focusEscapes,
  tabWrapFailures,
} from '../support/focus-trap.util.js';

/**
 * `/admin/members/invitations` — the screen an invitation exists on after the tab that created it
 * was closed.
 *
 * The properties, and none of them is «the request was made»:
 *
 *   * **an invitation that has run out stays on the list**, marked by a word and not only by a
 *     colour. Hiding it would leave it addressable by id and invisible on the screen that addresses
 *     it — and it is precisely the row somebody came here to re-issue or close;
 *   * **a name is a name or a dash, never an identifier.** The row carries `roleId`, `teamIds` and
 *     `invitedById`; naming them is three other permissions, and a reader without them sees a dash
 *     while the screen makes no request certain to be refused (STORY-012-08, D1);
 *   * **the two controls are hints**, drawn from the two capabilities the endpoints check;
 *   * **both actions are confirmed**, and the confirmation says what will be true afterwards rather
 *     than reporting it once it is;
 *   * **the two refusals are two sentences.** `404` is «already closed or never there», `409` is
 *     «already accepted» — and «already closed» about an invitation somebody accepted this morning
 *     is a lie to the person deciding whether to invite them again (D2);
 *   * **the re-issued link is shown once, in the panel the invite screen uses**, and it leaves with
 *     the dialog: it lives in the mutation result and nowhere else;
 *   * **the dialog traps focus and gives it back** (`rules/a11y.mdc` §6).
 */

const OPEN_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b01';
const EXPIRED_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b02';
const NEWEST_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b03';
const INVITER_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af1';
const ROLE_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a91';
const TEAM_ID = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a81';
const INVITE_URL = 'https://crm.example.test/invite/opaque-token';

/** A year away and a year ago, so the two cases below cannot both be «now, roughly». */
const FAR_FUTURE = '2099-01-01T10:00:00.000Z';
const LONG_PAST = '2020-01-01T10:00:00.000Z';

const invitation = (
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  email: `${id.slice(-4)}@example.test`,
  roleId: ROLE_ID,
  teamIds: [TEAM_ID],
  locale: 'en',
  invitedById: INVITER_ID,
  expiresAt: FAR_FUTURE,
  createdAt: '2026-08-13T10:00:00.000Z',
  ...overrides,
});

const OPEN = invitation(OPEN_ID);
/** No role and no teams — the shape the invite form produces today, and a legitimate invitation. */
const BARE = invitation('018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b04', { roleId: null, teamIds: [] });
const EXPIRED = invitation(EXPIRED_ID, { expiresAt: LONG_PAST });
const NEWEST = invitation(NEWEST_ID);

const ROLES = {
  items: [
    {
      id: ROLE_ID,
      key: 'tech_writer',
      name: 'Technical writer',
      description: null,
      isSystem: false,
      isDefault: false,
      holderCount: 2,
      permissions: ['task:read'],
    },
  ],
};

const TEAMS = {
  items: [{ id: TEAM_ID, name: 'Platform', slug: 'platform', description: null, memberCount: 3 }],
};

const PEOPLE = {
  items: [
    {
      userId: INVITER_ID,
      email: 'anna@example.test',
      firstName: 'Anna',
      lastName: 'Ivanova',
      jobTitle: null,
      department: null,
      status: 'ACTIVE',
      roles: [],
      teams: [],
    },
  ],
  page: 1,
  perPage: 100,
  total: 1,
  facets: { status: [], role: [], team: [] },
};

let sent: { url: string; method: string }[];

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
  /** What `/me/permissions` grants. The default is the caller most of this file is about. */
  readonly granted?: readonly string[];
  /** Evaluated per request, so a retry — or a refetch after a mutation — can answer differently. */
  readonly list?: () => Response;
  readonly resend?: () => Response;
  readonly revoke?: () => Response;
  /** A real catalogue instead of the suite's `cimode` one — see «in a real language» below. */
  readonly i18n?: I18n;
  readonly language?: string;
}

const READER = ['invitation:read', 'role:read', 'team:read', 'employee:read'];
const FULL = [...READER, 'invitation:resend', 'invitation:revoke'];

const startAt = async ({
  granted = FULL,
  list = () => json({ items: [NEWEST, OPEN, EXPIRED] }),
  resend = () =>
    json({
      id: OPEN_ID,
      email: OPEN['email'],
      inviteUrl: INVITE_URL,
      expiresAt: FAR_FUTURE,
      mailDispatched: true,
    }),
  revoke = () => new Response(null, { status: 204 }),
  i18n,
  language,
}: Answers = {}): Promise<void> => {
  vi.resetModules();
  vi.stubGlobal('fetch', (input: Request) => {
    const url = new URL(input.url).pathname;

    sent.push({ url, method: input.method });

    if (url.endsWith('/me/permissions')) {
      return json({ permissions: [...granted], denied: [], roles: [], isOwner: false, version: 1 });
    }
    if (url.endsWith('/resend')) return resend();
    if (input.method === 'DELETE') return revoke();
    if (url.endsWith('/invitations')) return list();
    if (url.endsWith('/roles')) return json(ROLES);
    if (url.endsWith('/teams')) return json(TEAMS);
    if (url.endsWith('/employees')) return json(PEOPLE);

    return json({ status: 'ok' });
  });

  const { renderApp } = await import('../support/render-app.util.js');

  renderApp({
    path: '/admin/members/invitations',
    status: 'authenticated',
    ...(i18n === undefined ? {} : { i18n }),
    ...(language === undefined ? {} : { language }),
  });
};

const asked = (fragment: string): boolean => sent.some((call) => call.url.endsWith(fragment));

/**
 * The row an address is on.
 *
 * Rows are found and then scoped, rather than the control being found by a label that names the
 * address: the whole suite runs in `cimode`, where `t(key)` answers with the key and **drops the
 * interpolation** — every row's control has the accessible name `…action.resendAria`, address and
 * all missing. A label-based lookup would therefore either time out or pick an arbitrary row while
 * reading as though it had picked this one. The address *is* asserted to reach the label, in the
 * two real-language cases at the bottom, which is the only place it can be.
 */
const rowOf = async (email: string): Promise<HTMLElement> => {
  const cell = await screen.findByText(email);
  const row = cell.closest('tr');

  expect(row, `no row carries ${email}`).not.toBeNull();

  return row as HTMLElement;
};

/** Opens the confirmation of one action on one row, and hands back the dialog. */
const openDialog = async (
  user: UserEvent,
  action: 'resend' | 'revoke',
  email: string,
): Promise<HTMLElement> => {
  const row = await rowOf(email);

  await user.click(within(row).getByRole('button', { name: new RegExp(`action\\.${action}Aria`) }));

  return await screen.findByRole('dialog');
};

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('the invitations screen', () => {
  it('refuses somebody who may not read invitations, and says what they are missing', async () => {
    // Forbidden, not «nothing here»: `/admin/**` is in everybody's navigation, so naming the
    // permission leaks nothing and turns the refusal into something an administrator can grant.
    await startAt({ granted: ['task:read'] });

    expect(await screen.findByTestId('forbidden-state')).toHaveTextContent('invitation:read');
    expect(asked('/invitations')).toBe(false);
  });

  it('shows every open invitation, including one that has run out', async () => {
    await startAt();

    const rows = await screen.findAllByRole('row');

    // Three invitations and a header row — the expired one is on the list, not filtered out of it.
    expect(rows).toHaveLength(4);
    expect(screen.getByText(String(EXPIRED['email']))).toBeInTheDocument();

    // Marked by a word, and by exactly one row: a badge on all three would pass a «is it shown»
    // assertion while meaning nothing (`rules/a11y.mdc` §2).
    const marks = screen.getAllByText(/invitations\.expired/);

    expect(marks).toHaveLength(1);
    expect(within(rows[3] as HTMLElement).getByText(/invitations\.expired/)).toBeInTheDocument();
  });

  /**
   * The order is the server's — `ORDER BY created_at DESC` — and the screen sorts nothing. A client
   * that re-sorted would be answering a question the endpoint already answered, and differently.
   */
  it('keeps the order the server sent', async () => {
    await startAt();

    const rows = await screen.findAllByRole('row');
    const emails = rows
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0]?.textContent ?? '');

    expect(emails).toEqual([NEWEST['email'], OPEN['email'], EXPIRED['email']]);
  });

  /**
   * «No role for now» is a legitimate invitation — `roleId: null` is what the form sends when the
   * access is decided after a conversation — and an empty `teamIds` is what it always sends today.
   * Both land on the same dash as a name the reader may not be told, which is the point of the
   * fallback being one rule rather than three conditions.
   */
  it('shows a dash for an invitation that carries no role and no teams', async () => {
    await startAt({ list: () => json({ items: [BARE] }) });

    const row = within(await rowOf(String(BARE['email'])));

    expect(row.getAllByText('—')).toHaveLength(2);
    // CONTROL: the reader may be told — the inviter is named on the very same row, so the two
    // dashes above are about what the invitation carries and not about a permission.
    expect(await row.findByText('Anna Ivanova')).toBeInTheDocument();
  });

  it('names the role, the teams and the inviter when the reader may be told', async () => {
    await startAt();

    const row = within(await rowOf(String(OPEN['email'])));

    expect(await row.findByText('Technical writer')).toBeInTheDocument();
    expect(await row.findByText('Platform')).toBeInTheDocument();
    expect(await row.findByText('Anna Ivanova')).toBeInTheDocument();
  });

  /**
   * And asks for none of them otherwise.
   *
   * A dash rather than the UUID the row does carry: an identifier in a table cell is noise a person
   * has to ignore. The absence of the three requests is the other half — a request certain to be
   * refused is not a graceful fallback, it is a 403 per page view.
   */
  it('shows a dash instead of an identifier, and asks nobody, without the three permissions', async () => {
    await startAt({ granted: ['invitation:read'] });

    await screen.findByText(String(OPEN['email']));

    expect(screen.queryByText(ROLE_ID)).toBeNull();
    expect(screen.queryByText(TEAM_ID)).toBeNull();
    expect(screen.queryByText(INVITER_ID)).toBeNull();
    expect(asked('/roles')).toBe(false);
    expect(asked('/teams')).toBe(false);
    expect(asked('/employees')).toBe(false);
    // CONTROL: the one request the screen is entitled to was made, so the absences above are about
    // the permissions rather than about a screen that never loaded.
    expect(asked('/invitations')).toBe(true);
  });

  it('offers neither action to a reader who holds only invitation:read', async () => {
    await startAt({ granted: READER });

    await screen.findByText(String(OPEN['email']));

    expect(screen.queryByRole('button', { name: /action\.resendAria/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /action\.revokeAria/ })).toBeNull();
    // Neither did it send anything: a control that is not drawn cannot be pressed.
    expect(sent.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it.each([
    ['re-issue', 'invitation:resend', 'resendAria', 'revokeAria'],
    ['close', 'invitation:revoke', 'revokeAria', 'resendAria'],
  ])(
    'offers only %s to somebody who holds only that capability',
    async (_case, permission, offered, hidden) => {
      await startAt({ granted: [...READER, permission] });

      expect(
        await screen.findAllByRole('button', { name: new RegExp(`action\\.${offered}`) }),
      ).toHaveLength(3);
      expect(screen.queryByRole('button', { name: new RegExp(`action\\.${hidden}`) })).toBeNull();
    },
  );

  it('says so, with a way back, when the list cannot be loaded', async () => {
    let recovers = false;

    await startAt({
      list: () => (recovers ? json({ items: [OPEN] }) : problem('internal_error', 500)),
    });

    await screen.findByTestId('error-state');
    expect(screen.getByText(/invitations\.failed/)).toBeInTheDocument();

    // CONTROL: retry succeeds — the failure was the answer, not the screen.
    recovers = true;
    await userEvent.setup().click(screen.getByRole('button', { name: 'common.retry' }));

    expect(await screen.findByText(String(OPEN['email']))).toBeInTheDocument();
  });

  it('offers the form rather than a dead end when nobody is waiting', async () => {
    await startAt({ granted: [...FULL, 'invitation:create'], list: () => json({ items: [] }) });

    const empty = within(await screen.findByTestId('empty-state'));

    expect(screen.getByTestId('empty-state')).toHaveTextContent('invitations.empty.title');
    // Scoped to the empty state: the page header carries a link to the same screen, and an
    // unscoped lookup would be satisfied by that one while claiming this one exists.
    expect(empty.getByRole('link', { name: /invite\.title/ })).toBeInTheDocument();
  });
});

describe('closing an invitation', () => {
  it('says what will be true afterwards, before the button that does it', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openDialog(user, 'revoke', String(OPEN['email'])));

    expect(dialog.getByText(/revoke\.consequence\.link/)).toBeInTheDocument();
    expect(dialog.getByText(/revoke\.consequence\.person/)).toBeInTheDocument();
    expect(dialog.getByText(/revoke\.consequence\.permanent/)).toBeInTheDocument();
    // Nothing was sent by opening the question.
    expect(sent.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('abandons on Cancel without closing anything', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user, 'revoke', String(OPEN['email']));

    await user.click(within(dialog).getByRole('button', { name: /invitations\.cancel/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(sent.some((call) => call.method === 'DELETE')).toBe(false);
  });

  /**
   * The window Cancel opens, and the reason the confirm handler starts with a guard.
   *
   * The dialog is mounted for the whole life of the screen — it has to be, or the focus never comes
   * back to the control that opened it — so «closed» is `opened={false}` plus an exit transition,
   * not an unmount. For the length of that transition the confirm button is still on screen and
   * still clickable, while the question it belonged to has already been dropped. A confirm handler
   * that read the question without checking would act on `null` here; one that defaulted instead
   * would revoke whichever invitation the placeholders happen to name.
   *
   * Asserted on the network rather than on the dialog: what must not happen is a deletion nobody
   * confirmed. The click is deliberately not preceded by a wait for the dialog to go — waiting is
   * what would close the window this is about.
   */
  it('ignores a confirm that lands while the dialog is closing', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user, 'revoke', String(OPEN['email']));
    const confirm = within(dialog).getByRole('button', { name: /revoke\.confirm/ });

    await user.click(within(dialog).getByRole('button', { name: /invitations\.cancel/ }));
    await user.click(confirm);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(sent.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('deletes the row, re-reads the list and reports it once', async () => {
    const user = userEvent.setup();
    let closed = false;

    await startAt({
      list: () => json({ items: closed ? [NEWEST, EXPIRED] : [NEWEST, OPEN, EXPIRED] }),
      revoke: () => {
        closed = true;

        return new Response(null, { status: 204 });
      },
    });

    const dialog = await openDialog(user, 'revoke', String(OPEN['email']));

    await user.click(within(dialog).getByRole('button', { name: /revoke\.confirm/ }));

    // The dialog goes, because the row it was about is gone.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.queryByText(String(OPEN['email']))).toBeNull();
    });
    // And its neighbours are still there — a list that emptied itself would satisfy the line above.
    expect(screen.getByText(String(NEWEST['email']))).toBeInTheDocument();
    expect(screen.getByText(String(EXPIRED['email']))).toBeInTheDocument();

    // One signal for one action: the toast, and no banner beside it.
    expect(await screen.findAllByText(/invitations\.revoked/)).toHaveLength(1);
  });

  /**
   * Two refusals, two sentences (D2).
   *
   * `404` and `409` mean different things to the person deciding whether to invite this colleague
   * again, and merging them into «already closed» is a lie in half the cases. Both are rendered
   * **inside** the dialog: it is `aria-modal="true"`, so a toast outside it is no signal at all for
   * a screen-reader user.
   */
  it.each([
    ['already closed or never there', 'invitation_not_found', 404],
    ['already accepted', 'invitation_already_accepted', 409],
  ])(
    'shows the refusal for an invitation %s, in the dialog and once',
    async (_case, code, status) => {
      const user = userEvent.setup();

      await startAt({ revoke: () => problem(code, status) });

      const dialog = await openDialog(user, 'revoke', String(OPEN['email']));

      await user.click(within(dialog).getByRole('button', { name: /revoke\.confirm/ }));

      expect(await within(dialog).findByText(/revoke\.failed/)).toBeInTheDocument();
      // The two codes are two different sentences, and each appears exactly once on the screen.
      expect(screen.getAllByText(`errors.code.${code}`)).toHaveLength(1);
      // The dialog stays open: a refusal is an answer to read, not a reason to start again.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    },
  );
});

describe('re-issuing an invitation', () => {
  /**
   * The refusal path of the *other* action, and it needed its own case rather than trusting the
   * revoke one above: the two live on separate `failureKey` branches of `useInvitationList`, and
   * neither is reached by the other's test. Until this existed, the sentence a person reads when a
   * re-issue fails was asserted by nothing at all.
   */
  it('shows the refusal when the re-issue is refused, and keeps the dialog open', async () => {
    const user = userEvent.setup();

    await startAt({ resend: () => problem('invitation_already_accepted', 409) });

    const dialog = await openDialog(user, 'resend', String(OPEN['email']));

    await user.click(within(dialog).getByRole('button', { name: /resend\.confirm/ }));

    expect(await within(dialog).findByText(/resend\.failed/)).toBeInTheDocument();
    expect(screen.getAllByText('errors.code.invitation_already_accepted')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows the new link once, in the panel the invite screen uses', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user, 'resend', String(OPEN['email']));

    expect(within(dialog).getByText(/resend\.consequence\.oldLink/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /resend\.confirm/ }));

    // The dialog stays open — the link is the only copy that will ever exist.
    expect(await within(dialog).findByText(INVITE_URL)).toBeInTheDocument();
    expect(within(dialog).getByText(/invitations\.reissued/)).toBeInTheDocument();
    // The panel is `InvitationLink`, so it also carries the sentence about the relay.
    expect(within(dialog).getByText(/invite\.sent/)).toBeInTheDocument();
  });

  it('copies the link the response carried, and says so when the clipboard refuses', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.reject(new Error('denied')));

    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    await startAt();

    const dialog = await openDialog(user, 'resend', String(OPEN['email']));

    await user.click(within(dialog).getByRole('button', { name: /resend\.confirm/ }));
    await within(dialog).findByText(INVITE_URL);
    await user.click(within(dialog).getByRole('button', { name: /invite\.copy/ }));

    expect(writeText).toHaveBeenCalledWith(INVITE_URL);
    // Silence here loses the only copy of a credential: the link is shown once.
    expect(await screen.findByText(/invite\.copyFailed/)).toBeInTheDocument();
    expect(within(dialog).getByText(INVITE_URL)).toBeInTheDocument();
  });

  /**
   * The link leaves with the dialog (criterion 8).
   *
   * It lives in the mutation result — `gcTime: 0` — and nowhere else: not in the URL, not in
   * storage, not in a query key. Closing resets the mutation, so the next question starts from the
   * question rather than from somebody else's credential.
   */
  it('forgets the link when the dialog is closed, and does not carry it to the next row', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user, 'resend', String(OPEN['email']));

    await user.click(within(dialog).getByRole('button', { name: /resend\.confirm/ }));
    await within(dialog).findByText(INVITE_URL);

    await user.click(
      within(dialog).getAllByRole('button', { name: /invitations\.close/ })[0] as HTMLElement,
    );

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.queryByText(INVITE_URL)).toBeNull();
    expect(globalThis.localStorage.getItem('bc-invitation') ?? '').not.toContain(INVITE_URL);
    expect(globalThis.location.href).not.toContain('opaque-token');

    // The next row starts from the question, not from the previous answer.
    const reopened = within(await openDialog(user, 'resend', String(NEWEST['email'])));

    expect(reopened.queryByText(INVITE_URL)).toBeNull();
    expect(reopened.getByRole('button', { name: /resend\.confirm/ })).toBeInTheDocument();
  });
});

/**
 * The four sentences of `rules/a11y.mdc` §6. Tabbing out of a modal that deletes an invitation is
 * how a confirmation gets confirmed by a keystroke meant for the page behind it.
 */
describe('the confirmation dialog and the keyboard', () => {
  it('moves the focus into itself', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user, 'revoke', String(OPEN['email']));

    await waitFor(() => {
      // The header cross: the first tabbable node, and the safe one — not the red button.
      expect(expectFocusInside(dialog)).toHaveAccessibleName(/invitations\.close/);
    });
  });

  it('keeps the focus inside itself, in both directions', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user, 'revoke', String(OPEN['email']));
    const behind = within(await rowOf(String(NEWEST['email']))).getByRole('button', {
      name: /action\.revokeAria/,
    });

    expect(await focusEscapes(user, dialog, behind)).toEqual([]);
  });

  it('wraps at both ends rather than swallowing the key', async () => {
    const user = userEvent.setup();

    await startAt();

    expect(
      await tabWrapFailures(user, await openDialog(user, 'revoke', String(OPEN['email']))),
    ).toEqual([]);
  });

  /**
   * `Esc` abandons, and abandoning is the whole of what it does. The absence of the request is the
   * assertion: once the dialog is gone, «Escape closed it» and «Escape confirmed it» look the same
   * from outside, and the second would delete an invitation from a keystroke aimed at the page.
   */
  it('abandons on Escape without closing anything, and gives the focus back', async () => {
    const user = userEvent.setup();

    await startAt();

    const trigger = within(await rowOf(String(OPEN['email']))).getByRole('button', {
      name: /action\.revokeAria/,
    });

    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expectFocusReturnedTo(trigger, 'the control that opens the confirmation');
    });
    expect(sent.some((call) => call.method === 'DELETE')).toBe(false);
  });
});

/**
 * axe over both faces of the dialog, and over the table behind it.
 *
 * The link panel is not a variation on the question: it is a `Code` block and a copy control where
 * the consequences were, and scanning only the state a case happens to leave behind is how the half
 * nobody looks at ships with a violation.
 */
describe.each([
  ['while the question is on screen', false],
  ['while the re-issued link is on screen', true],
] as const)('the confirmation dialog has no accessibility violation %s', (_case, confirmFirst) => {
  it('passes axe', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user, 'resend', String(OPEN['email']));

    if (confirmFirst) {
      await user.click(within(dialog).getByRole('button', { name: /resend\.confirm/ }));
      await within(dialog).findByText(INVITE_URL);
    }

    const { violations, passes } = await axe.run(dialog, {
      rules: {
        // Disabled because jsdom cannot answer it, not because the answer is inconvenient — and the
        // premise is checked below rather than claimed here. Contrast is measured where it can be:
        // `test/theme/tokens.test.ts` over every token pair, and `@axe-core/playwright` in e2e.
        'color-contrast': { enabled: false },
        // A document-level heuristic that does not model `aria-modal`: while this dialog is open the
        // shell behind it is inert for assistive technology, so its header is not a second banner in
        // any sense a reader experiences. The premise is asserted below.
        'landmark-no-duplicate-banner': { enabled: false },
      },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
    // CONTROL: the scan looked at this subtree rather than at nothing. `button-name` is in the list
    // because the modal's close cross is exactly the control that fails it when unlabelled.
    expect(passes.map((rule) => rule.id)).toContain('button-name');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // The premise of the contrast exemption: the token stylesheet is never applied in jsdom, so
    // anything the rule read would be a user-agent default.
    expect(globalThis.getComputedStyle(dialog).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  });
});

/** And the table itself, which no case above scans. */
describe('the invitations table', () => {
  it('has no accessibility violation', async () => {
    await startAt();

    await screen.findByText(String(OPEN['email']));

    const table = screen.getByRole('table');
    const { violations, passes } = await axe.run(table, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
    // CONTROL: the scan found this table's own structure rather than an empty subtree.
    expect(passes.map((rule) => rule.id)).toContain('th-has-data-cells');
  });
});

/**
 * The one property `cimode` cannot state.
 *
 * Every assertion above matches a **key**, which is what makes them readable and what makes them
 * blind: under `cimode` `t(key)` returns the key, so a component that forgot `t()` renders
 * identically to one that remembers. Both catalogues are therefore rendered for real, and what is
 * asserted is what an administrator has to be able to read — that this invitation has run out, and
 * that re-issuing kills the link somebody may already have been sent.
 */
describe.each(['en', 'ru'] as const)('the invitations screen in %s', (language) => {
  it('reads as prose rather than as keys', async () => {
    const user = userEvent.setup();
    const i18n = SharedI18n.createI18n(language);

    await startAt({ i18n, language });

    // Named through the catalogue, not through a key: in a real language the mark reads «Expired» /
    // «Просрочено», and a regex over the key would find nothing here.
    expect(await screen.findByText(i18n.t('members.invitations.expired'))).toBeInTheDocument();
    // Nothing left as a key: `members.` on screen is a `t()` that was never called.
    expect(screen.queryAllByText(/^members\./)).toEqual([]);

    await user.click(
      screen.getAllByRole('button', {
        name: i18n.t('members.invitations.action.resendAria', { email: OPEN['email'] }),
      })[0] as HTMLElement,
    );

    const dialog = within(await screen.findByRole('dialog'));

    expect(
      dialog.getByText(i18n.t('members.invitations.resend.consequence.oldLink')),
    ).toBeInTheDocument();
    // Nothing left un-interpolated: a placeholder on screen is a key renamed on one side only.
    expect(dialog.queryByText(/\{\{/)).toBeNull();
    expect(dialog.getByText(new RegExp(String(OPEN['email'])))).toBeInTheDocument();
  });
});
