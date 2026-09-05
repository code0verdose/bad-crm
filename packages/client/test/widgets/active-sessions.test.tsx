import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type i18n as I18n } from 'i18next';

import { SharedI18n } from '@shared';

import { axeViolationsIn } from '../support/axe-scan.util.js';
import {
  expectFocusInside,
  expectFocusReturnedTo,
  focusEscapes,
  tabWrapFailures,
} from '../support/focus-trap.util.js';
import { type RenderedApp } from '../support/render-app.util.js';

/**
 * Where this account is signed in, on `/settings/security`.
 *
 * `GET /auth/sessions` and both revocations shipped with EPIC-006 and were called by nothing for a
 * month: the whole point of the endpoint — «I signed in on somebody else's laptop and I want it
 * closed» — was unreachable from the product. What this suite states is the half a server test
 * cannot:
 *
 *   * **the current session is distinguishable, and its button says something different.** Closing
 *     it is not «revoke a session», it is signing out, and a row that looked like every other row
 *     would let somebody lock themselves out of the tab they are reading;
 *   * **nothing is closed without being asked.** Both operations are irreversible in the only sense
 *     that matters — a closed session cannot be reopened — so both go through a confirmation
 *     (`rules/design-system.mdc` §17), and the confirmation names the row it is about;
 *   * **closing the current session performs the sign-out** rather than waiting for the next request
 *     to discover a 401: the token is forgotten, the session store is ended, and `logged-out` is
 *     announced — which is what `app/auth-events.util.ts` turns into the navigation;
 *   * **a refusal stays inside the dialog.** It is `aria-modal="true"`, so a toast behind it is, for
 *     a screen-reader user, no signal at all;
 *   * **the count in the message is the server's**, because a second press closes nothing and has to
 *     say so.
 */

/** Something for the sign-out to have to forget; the value never leaves this file. */
const ACCESS_TOKEN = 'header.payload.signature';

const CURRENT_ID = '4f1c2f4a-0a6d-4a7b-9a1e-2d3c4b5a6f70';
const OTHER_ID = '9b7d6e55-31a2-4c0f-8f21-6ac0d9e14b83';

const CURRENT_SESSION = {
  id: CURRENT_ID,
  current: true,
  device: 'Firefox on macOS',
  ipMasked: '203.0.113.0/24',
  createdAt: '2026-08-27T09:41:12.004Z',
  lastUsedAt: '2026-08-28T11:02:44.881Z',
  expiresAt: '2026-09-26T09:41:12.004Z',
};

const OTHER_SESSION = {
  id: OTHER_ID,
  current: false,
  device: 'Chrome on Android',
  ipMasked: '2001:db8:85a3::/48',
  createdAt: '2026-08-20T18:12:00.000Z',
  lastUsedAt: '2026-08-20T18:12:00.000Z',
  expiresAt: '2026-09-19T18:12:00.000Z',
};

interface Call {
  readonly url: string;
  readonly method: string;
}

let sent: Call[];
let unsubscribe: (() => void) | undefined;
/** Every session event this tab announced — see `startAt` for why the bus is where it is read. */
let announced: string[];
let authSession: { readonly read: () => { readonly status: string } };
let readAccessToken: () => string | null;
/** What the list answers — mutated by a successful revocation, exactly as the server would. */
let sessions: unknown[];

const platformFetch = globalThis.fetch;

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
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
  readonly revoke?: (sessionId: string) => Response;
  readonly revokeOthers?: () => Response;
  readonly i18n?: I18n;
  readonly language?: string;
}

const startAt = async ({
  revoke = (sessionId) => {
    sessions = sessions.filter((session) => (session as { id: string }).id !== sessionId);

    return noContent();
  },
  revokeOthers = () => {
    const closed = sessions.length - 1;

    sessions = sessions.filter((session) => (session as { current: boolean }).current);

    return json({ revokedCount: closed });
  },
  i18n,
  language,
}: Answers = {}): Promise<RenderedApp> => {
  vi.resetModules();
  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url).pathname;

    sent.push({ url, method: input.method });

    if (url.endsWith('/me/permissions')) {
      return json({ permissions: [], denied: [], roles: [], isOwner: false, version: 1 });
    }
    if (url.endsWith('/2fa/recovery-codes')) return json({ total: 0, remaining: 0 });
    if (url.endsWith('/auth/sessions/revoke-others')) return revokeOthers();
    if (url.endsWith('/auth/sessions')) return json({ items: sessions });
    if (input.method === 'DELETE') return revoke(url.split('/').pop() ?? '');

    return json({ status: 'ok' });
  });

  const [{ renderApp }, { AuthLib, AuthService }] = await Promise.all([
    import('../support/render-app.util.js'),
    import('@units/auth'),
  ]);

  authSession = AuthService.authSession;
  readAccessToken = AuthLib.readAccessToken;
  AuthLib.setAccessToken(ACCESS_TOKEN);

  /**
   * What the tab announced about its own session, in order.
   *
   * The bus is where `units/auth` stops: it says «logged-out» and knows nothing about a router,
   * because a transport module that imports one cannot be tested without one. The subscriber that
   * turns the announcement into a navigation and a cache wipe is `app/auth-events.util.ts`, wired in
   * `app/main.tsx` and proved in `test/routes/sign-in-flow.test.tsx`; installing it here would prove
   * nothing extra, because the harness fixes the router's session status at construction and
   * `redirectIfAuthed` therefore bounces `/login` straight back. What is this screen's own contract
   * is that the announcement is made at all — a revocation that only invalidated a list would leave
   * the tab sitting there, signed out, until the next request discovered a 401.
   */
  unsubscribe = AuthLib.onAuthEvent((event) => {
    announced.push(event);
  });

  const rendered = renderApp({
    path: '/settings/security',
    status: 'authenticated',
    ...(i18n === undefined ? {} : { i18n }),
    ...(language === undefined ? {} : { language }),
  });

  return rendered;
};

const callsTo = (suffix: string, method: string): Call[] =>
  sent.filter((call) => call.url.endsWith(suffix) && call.method === method);

/** The row of a device, found by the one thing on screen that names it. */
const rowOf = async (device: string): Promise<HTMLElement> =>
  (await screen.findByText(device)).closest('tr')!;

const signOutTrigger = (): HTMLElement =>
  screen.getByRole('button', { name: /security\.sessions\.action\.signOutAria/ });

const othersTrigger = (): HTMLElement =>
  screen.getByRole('button', { name: /security\.sessions\.action\.others/ });

const openFrom = async (user: UserEvent, trigger: HTMLElement): Promise<HTMLElement> => {
  await user.click(trigger);

  return await screen.findByRole('dialog');
};

const confirm = async (user: UserEvent, dialog: HTMLElement, kind: string): Promise<void> => {
  await user.click(
    within(dialog).getByRole('button', {
      name: new RegExp(`security\\.sessions\\.dialog\\.${kind}\\.confirm`),
    }),
  );
};

beforeEach(() => {
  sent = [];
  announced = [];
  sessions = [CURRENT_SESSION, OTHER_SESSION];
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  vi.stubGlobal('fetch', platformFetch);
});

describe('the list', () => {
  it('shows one row per device, with what the contract carries about it', async () => {
    await startAt();

    const other = within(await rowOf('Chrome on Android'));

    expect(other.getByText('2001:db8:85a3::/48')).toBeInTheDocument();
    expect(await rowOf('Firefox on macOS')).toBeInTheDocument();
  });

  /**
   * The current session is marked, and marked in words.
   *
   * Without it somebody looking for the laptop they left in a hotel has no way to tell which row is
   * the browser they are reading — and the one row they must not close by accident is the one they
   * cannot get back. A colour or a highlighted row would carry it in colour alone
   * (`rules/a11y.mdc` §2).
   */
  it('says which row is this device', async () => {
    await startAt();

    const current = within(await rowOf('Firefox on macOS'));

    expect(current.getByText(/security\.sessions\.current/)).toBeInTheDocument();
    expect(
      within(await rowOf('Chrome on Android')).queryByText(/security\.sessions\.current/),
    ).toBeNull();
  });

  /**
   * `unknown` is a value the contract states rather than an absent field, and it is a word in
   * English — so it is translated rather than printed.
   *
   * A deployment behind a unix socket, or one whose proxy writes no `X-Forwarded-For`, has no
   * address to show; putting the literal `unknown` in a Russian table would be the one cell on the
   * screen that is not in the reader's language.
   */
  it('says so in words when the deployment had no address to record', async () => {
    sessions = [CURRENT_SESSION, { ...OTHER_SESSION, ipMasked: 'unknown' }];

    await startAt();

    const other = within(await rowOf('Chrome on Android'));

    expect(other.getByText(/security\.sessions\.unknownAddress/)).toBeInTheDocument();
    expect(other.queryByText('unknown')).toBeNull();
  });

  /**
   * Each button names its row.
   *
   * Every row carries the same word, so a shared label leaves a screen reader hearing «close,
   * close, close» with no way to tell which device it is on (`rules/a11y.mdc` §17).
   */
  it('gives every action a label that names the device it acts on', async () => {
    await startAt();

    expect(
      within(await rowOf('Chrome on Android')).getByRole('button', {
        name: /security\.sessions\.action\.revokeAria/,
      }),
    ).toBeInTheDocument();
  });

  /** And the row the tab is using offers signing out, not «close a session». */
  it('offers the current row a sign-out rather than a revocation', async () => {
    await startAt();

    const current = within(await rowOf('Firefox on macOS'));

    expect(
      current.getByRole('button', { name: /security\.sessions\.action\.signOutAria/ }),
    ).toBeInTheDocument();
    expect(
      current.queryByRole('button', { name: /security\.sessions\.action\.revokeAria/ }),
    ).toBeNull();
  });

  /**
   * «Close every other session» is offered only when there is one.
   *
   * On a single-session account the button can do nothing: it would answer `revokedCount: 0` and
   * report that nothing happened, which is a control that exists to disappoint.
   */
  it('offers to close the rest while there is a rest', async () => {
    await startAt();
    await rowOf('Firefox on macOS');

    expect(othersTrigger()).toBeInTheDocument();
  });

  it('does not offer it on an account with one session', async () => {
    sessions = [CURRENT_SESSION];

    await startAt();
    await rowOf('Firefox on macOS');

    expect(screen.queryByRole('button', { name: /security\.sessions\.action\.others/ })).toBeNull();
  });
});

describe('closing somebody else’s device', () => {
  it('asks first, and sends nothing until it is confirmed', async () => {
    const user = userEvent.setup();

    await startAt();

    const row = await rowOf('Chrome on Android');
    const dialog = await openFrom(
      user,
      within(row).getByRole('button', { name: /security\.sessions\.action\.revokeAria/ }),
    );

    expect(
      within(dialog).getByText(/security\.sessions\.dialog\.revoke\.description/),
    ).toBeInTheDocument();
    expect(callsTo(OTHER_ID, 'DELETE')).toEqual([]);
  });

  it('names every consequence, above the button that causes them', async () => {
    const user = userEvent.setup();

    await startAt();

    const row = await rowOf('Chrome on Android');
    const dialog = within(
      await openFrom(
        user,
        within(row).getByRole('button', { name: /security\.sessions\.action\.revokeAria/ }),
      ),
    );

    expect(dialog.getByText(/security\.sessions\.consequence\.immediate/)).toBeInTheDocument();
    expect(dialog.getByText(/security\.sessions\.consequence\.signInAgain/)).toBeInTheDocument();
    expect(dialog.getByText(/security\.sessions\.consequence\.noUndo/)).toBeInTheDocument();
  });

  it('closes exactly that session, and reads the list back', async () => {
    const user = userEvent.setup();

    await startAt();

    const row = await rowOf('Chrome on Android');
    const before = callsTo('/auth/sessions', 'GET').length;
    const dialog = await openFrom(
      user,
      within(row).getByRole('button', { name: /security\.sessions\.action\.revokeAria/ }),
    );

    await confirm(user, dialog, 'revoke');

    await waitFor(() => {
      expect(callsTo(OTHER_ID, 'DELETE')).toHaveLength(1);
    });
    // Read back rather than removed locally: which rows are left is the server's answer, and a row
    // taken off the screen by the client is a row that comes back on the next refetch.
    await waitFor(() => {
      expect(callsTo('/auth/sessions', 'GET').length).toBeGreaterThan(before);
    });
    await waitFor(() => {
      expect(screen.queryByText('Chrome on Android')).toBeNull();
    });
    expect(callsTo(CURRENT_ID, 'DELETE')).toEqual([]);
  });

  it('says so once, politely', async () => {
    const user = userEvent.setup();

    await startAt();

    const row = await rowOf('Chrome on Android');
    const dialog = await openFrom(
      user,
      within(row).getByRole('button', { name: /security\.sessions\.action\.revokeAria/ }),
    );

    await confirm(user, dialog, 'revoke');

    const toast = (await screen.findByText(/security\.sessions\.done\.revoked/)).closest(
      '[role="status"]',
    );

    expect(toast, 'the success is not inside a live region at all').not.toBeNull();
    expect(toast).toHaveAttribute('aria-live', 'polite');
    expect(screen.getAllByText(/security\.sessions\.done\.revoked/)).toHaveLength(1);
  });

  /**
   * A refusal stays in the dialog, and the dialog stays open.
   *
   * `404 session_not_found` is the realistic one and it is not an error the person made: the row
   * expired, or the device signed itself out, between the read and the button.
   */
  it('states a refusal inside the dialog, exactly once', async () => {
    const user = userEvent.setup();

    await startAt({ revoke: () => problem('session_not_found', 404) });

    const row = await rowOf('Chrome on Android');
    const dialog = await openFrom(
      user,
      within(row).getByRole('button', { name: /security\.sessions\.action\.revokeAria/ }),
    );

    await confirm(user, dialog, 'revoke');

    expect(
      await within(dialog).findByText(/security\.sessions\.failed\.title/),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/errors\.code\.session_not_found/)).toHaveLength(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('closing the rest', () => {
  it('reports the number the server closed, not the number on screen', async () => {
    const user = userEvent.setup();

    await startAt({ revokeOthers: () => json({ revokedCount: 4 }) });
    await rowOf('Firefox on macOS');

    const dialog = await openFrom(user, othersTrigger());

    await confirm(user, dialog, 'others');

    await waitFor(() => {
      expect(callsTo('/auth/sessions/revoke-others', 'POST')).toHaveLength(1);
    });
    expect(await screen.findByText(/security\.sessions\.done\.others/)).toBeInTheDocument();
  });

  /**
   * Zero gets its own sentence. It is not a failure and it is not rare — it is what a second press
   * produces — and «Other sessions closed: 0» reads as something having gone wrong
   * (`rules/i18n.mdc` §8).
   */
  it('has a sentence of its own for having closed nothing', async () => {
    const user = userEvent.setup();

    await startAt({ revokeOthers: () => json({ revokedCount: 0 }) });
    await rowOf('Firefox on macOS');

    const dialog = await openFrom(user, othersTrigger());

    await confirm(user, dialog, 'others');

    expect(await screen.findByText(/security\.sessions\.done\.othersNone/)).toBeInTheDocument();
  });

  /**
   * A refusal stays in the dialog here too, and it is the same rule as the per-row one: the
   * confirmation is `aria-modal="true"`, so a toast behind it is no signal at all for a
   * screen-reader user. Stated separately because it is a second mutation with its own `onError`,
   * and a mutation that forgot one would send the global toast instead — invisibly.
   */
  it('states a refusal inside the dialog, exactly once', async () => {
    const user = userEvent.setup();

    await startAt({ revokeOthers: () => problem('rate_limited', 429) });
    await rowOf('Firefox on macOS');

    const dialog = await openFrom(user, othersTrigger());

    await confirm(user, dialog, 'others');

    expect(
      await within(dialog).findByText(/security\.sessions\.failed\.title/),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/errors\.code\.rate_limited/)).toHaveLength(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('leaves this session alone', async () => {
    const user = userEvent.setup();

    const { router } = await startAt();

    await rowOf('Firefox on macOS');

    const dialog = await openFrom(user, othersTrigger());

    await confirm(user, dialog, 'others');

    await waitFor(() => {
      expect(callsTo('/auth/sessions/revoke-others', 'POST')).toHaveLength(1);
    });
    expect(await rowOf('Firefox on macOS')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/security');
  });
});

describe('closing this very session', () => {
  it('says what it really is before it does it', async () => {
    const user = userEvent.setup();

    await startAt();
    await rowOf('Firefox on macOS');

    const dialog = within(await openFrom(user, signOutTrigger()));

    expect(
      dialog.getByText(/security\.sessions\.dialog\.signOut\.description/),
    ).toBeInTheDocument();
    expect(dialog.getByText(/security\.sessions\.consequence\.here/)).toBeInTheDocument();
  });

  /**
   * And it is a sign-out, not a row disappearing from a list.
   *
   * The endpoint clears the refresh cookie and denylists the session id, so the tab is anonymous the
   * moment it answers. A screen that only invalidated the list would sit there, signed out, until
   * the next request discovered a 401 — which is being thrown out rather than leaving.
   */
  it('performs the sign-out: token forgotten, session ended, and the tab says so', async () => {
    const user = userEvent.setup();

    await startAt();
    await rowOf('Firefox on macOS');

    const dialog = await openFrom(user, signOutTrigger());

    // CONTROL: there is a token to forget, so «it is gone afterwards» is not trivially true.
    expect(readAccessToken()).toBe(ACCESS_TOKEN);

    await confirm(user, dialog, 'signOut');

    await waitFor(() => {
      expect(callsTo(CURRENT_ID, 'DELETE')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(announced).toContain('logged-out');
    });
    expect(readAccessToken()).toBeNull();
    expect(authSession.read().status).toBe('anonymous');
  });

  /**
   * And no green toast about it. The screen it would appear on is the sign-in form, and «that
   * session is closed» there describes a request rather than what happened.
   */
  it('does not congratulate the person on the way out', async () => {
    const user = userEvent.setup();

    await startAt();
    await rowOf('Firefox on macOS');

    const dialog = await openFrom(user, signOutTrigger());

    await confirm(user, dialog, 'signOut');

    await waitFor(() => {
      expect(announced).toContain('logged-out');
    });
    expect(screen.queryByText(/security\.sessions\.done\.revoked/)).toBeNull();
  });
});

describe('the keyboard', () => {
  const openRevoke = async (user: UserEvent): Promise<HTMLElement> => {
    const row = await rowOf('Chrome on Android');

    return await openFrom(
      user,
      within(row).getByRole('button', { name: /security\.sessions\.action\.revokeAria/ }),
    );
  };

  it('puts the focus inside the dialog when it opens', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openRevoke(user);

    await waitFor(() => {
      expect(expectFocusInside(dialog)).toBeInstanceOf(HTMLElement);
    });
  });

  it('keeps the focus inside itself, in both directions', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openRevoke(user);

    // The change-password form is on the screen behind, and its first field is a real, enabled,
    // tabbable input — without naming something the focus *could* have reached, «stayed inside» is
    // equally true of a page with nothing else on it.
    expect(
      await focusEscapes(user, dialog, screen.getByLabelText(/security\.password\.current\.label/)),
    ).toEqual([]);
  });

  it('wraps at both ends rather than swallowing the key', async () => {
    const user = userEvent.setup();

    await startAt();

    expect(await tabWrapFailures(user, await openRevoke(user))).toEqual([]);
  });

  /**
   * `Escape` closes it, which is the ordinary answer of `rules/a11y.mdc` §6 and the right one here:
   * nothing irreplaceable is on screen, and the safe outcome is the one where nothing happens.
   */
  it('closes on Escape and puts the focus back on the control that opened it', async () => {
    const user = userEvent.setup();

    await startAt();

    const row = await rowOf('Chrome on Android');
    const trigger = within(row).getByRole('button', {
      name: /security\.sessions\.action\.revokeAria/,
    });

    await openFrom(user, trigger);
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expectFocusReturnedTo(trigger, 'the control that opened the dialog');
    });
  });

  /**
   * After a *successful* revocation the trigger does not exist to return to — the row it lived in is
   * gone. Focus returned to a detached node is focus on `<body>`, which drops a keyboard user at the
   * top of the shell, so it goes to the page's `h1` instead — where the route announcer already
   * sends it when what a page is about changes (`rules/a11y.mdc` §21).
   */
  it('sends the focus to the page heading once the row it came from is gone', async () => {
    const user = userEvent.setup();

    await startAt();
    await confirm(user, await openRevoke(user), 'revoke');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    });
    // CONTROL: nowhere is the failure this replaces — focus on `<body>`, which is what a return to a
    // detached trigger actually produces.
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe('accessibility of the list', () => {
  it('has no violation while it is on screen', async () => {
    await startAt();
    await rowOf('Firefox on macOS');

    const table = screen.getByRole('table');

    expect(await axeViolationsIn(table, { control: 'th-has-data-cells' })).toEqual([]);
  });

  it('has no violation while a confirmation is open', async () => {
    const user = userEvent.setup();

    await startAt();

    const row = await rowOf('Chrome on Android');
    const dialog = await openFrom(
      user,
      within(row).getByRole('button', { name: /security\.sessions\.action\.revokeAria/ }),
    );

    expect(await axeViolationsIn(dialog, { modal: true, control: 'button-name' })).toEqual([]);
  });
});

/**
 * The one property `cimode` cannot state.
 *
 * Every assertion above matches a **key**: `security.sessions.consequence.noUndo` matches whether
 * the sentence says a closed session cannot be reopened or says nothing at all. Those sentences are
 * the entire reason both of these are confirmations rather than bare buttons, so both catalogues are
 * rendered for real.
 */
describe.each(['en', 'ru'] as const)('what the confirmation says in %s', (language) => {
  it('spells out all three consequences, in three different sentences', async () => {
    const i18n = SharedI18n.createI18n(language);
    const user = userEvent.setup();

    await startAt({ i18n, language });

    const row = await rowOf('Chrome on Android');

    await user.click(
      within(row).getByRole('button', {
        name: i18n.t('security.sessions.action.revokeAria', { device: 'Chrome on Android' }),
      }),
    );

    const dialog = within(await screen.findByRole('dialog'));
    const sentences = [
      i18n.t('security.sessions.consequence.immediate'),
      i18n.t('security.sessions.consequence.signInAgain'),
      i18n.t('security.sessions.consequence.noUndo'),
    ];

    expect(new Set(sentences).size).toBe(3);
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/^security\./);
      expect(dialog.getByText(sentence)).toBeInTheDocument();
    }

    // The device is in the question, interpolated rather than glued: a placeholder left on screen is
    // a key renamed on one side only.
    expect(
      dialog.getByText(
        i18n.t('security.sessions.dialog.revoke.description', { device: 'Chrome on Android' }),
      ),
    ).toBeInTheDocument();
    expect(dialog.queryByText(/\{\{/)).toBeNull();
  });
});
