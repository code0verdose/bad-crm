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

/**
 * Bringing a deactivated colleague back, from their personnel card — STORY-012-09, the client half
 * of a server operation that has been shipped and unreachable since EPIC-012.
 *
 * The properties, and why each one is worth a case:
 *
 *   * **the card knows the account is off from `status`, never from `terminatedAt`.** The date is an
 *     editable HR field under `employee:update` (decision D4 of the story): an administrator who
 *     enters a leaving date in advance would otherwise be shown a working account as disabled, and
 *     offered a button to «bring back» somebody who never left;
 *   * **absence of `status` is «you may not see this», not «the account is fine»** — the key is sent
 *     only to a holder of `user:read` and to the person themselves, so a card without it says
 *     nothing and offers nothing;
 *   * **the control is a hint, never a gate** (`rules/permissions.mdc` §11): no `user:reactivate`,
 *     no button — and the endpoint refuses on its own authority regardless;
 *   * **the dialog names the roles that come back, before the button.** Deactivation does not strip
 *     roles (STORY-012-06), so reactivation returns the whole of somebody's former power in one
 *     call. Naming them is the difference between restoring an account and restoring an
 *     administrator without noticing;
 *   * **the report says what reactivation did _not_ do.** `membershipsRestored: false` is the
 *     question the caller asks next, and a silent «done» sends an administrator away believing a
 *     colleague came back with their teams, projects and vaults;
 *   * **`alreadyActive: true` is an outcome, not a refusal** — two tabs, or two administrators;
 *   * **one signal** (decision D3): the report lives in the dialog and there is no toast, the same
 *     shape the offboarding and 2FA-reset dialogs on this card already take;
 *   * **the card is refreshed when the dialog closes, not when the request succeeds.** The section
 *     the dialog lives in is drawn only while the account is off; refreshing on success would take
 *     the report off the screen before anybody read it;
 *   * **focus is trapped and given back** — to the trigger when nothing happened, to the page
 *     heading when the successful run has just removed the trigger (the lesson `DisableTotp`
 *     already carries).
 */

const USER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af1';
const EMAIL = 'ivan@example.test';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

let sent: Call[];

const platformFetch = globalThis.fetch;

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
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

/** The personnel document, minus the account state — which every case below decides for itself. */
const PROFILE = {
  userId: USER,
  email: EMAIL,
  firstName: 'Ivan',
  lastName: 'Petrov',
  jobTitle: 'Backend engineer',
  department: 'Platform',
  managerId: null,
  timezone: 'Europe/Moscow',
  skills: [],
  employmentType: 'FULL_TIME',
  hiredAt: '2024-03-01',
  terminatedAt: null,
  weeklyCapacityHours: 40,
  emergencyContact: null,
};

/** `ReactivationResult`, as `docs/api/openapi.yaml` declares it. */
const RESULT = { userId: USER, alreadyActive: false, membershipsRestored: false };

/** What `GET /users/{userId}/permissions` answers — only `roles` is read here. */
const heldRoles = (roles: readonly { readonly key: string; readonly name: string }[]): unknown => ({
  userId: USER,
  isOwner: false,
  version: 3,
  roles: roles.map((role, index) => ({
    roleId: `018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a0${index}`,
    ...role,
  })),
  permissions: [],
});

const ROLES = [
  { key: 'admin', name: 'Administrator' },
  { key: 'developer', name: 'Developer' },
] as const;

interface Answers {
  /** What `/me/permissions` grants. The default is the caller this file is mostly about. */
  readonly granted?: readonly string[];
  /**
   * The account state the personnel document carries — `'absent'` for a document that carries no
   * `status` key at all.
   *
   * A word rather than `undefined`, and the difference is not cosmetic: `status: undefined` reaches
   * a destructuring default and silently means «suspended», which is how the case about a *missing*
   * key spent its first run asserting the opposite of its own name.
   */
  readonly status?: 'ACTIVE' | 'SUSPENDED' | 'INVITED' | 'absent';
  /** A leaving date on the personnel record — deliberately independent of the state above. */
  readonly terminatedAt?: string | null;
  readonly reactivate?: () => Response;
  /** What `GET /users/{userId}/permissions` answers. */
  readonly roles?: () => Response;
  /** A real catalogue instead of the suite's `cimode` one — see «in a real language» below. */
  readonly i18n?: I18n;
  readonly language?: string;
}

/**
 * The account state as the server would report it **after** a successful run: the document is read
 * again when the dialog closes, and the card has to come back active.
 */
let accountStatus: 'ACTIVE' | 'SUSPENDED' | 'INVITED' | 'absent';

const startAt = async ({
  granted = ['employee:read', 'user:read', 'user:reactivate', 'permission:override_read'],
  status = 'SUSPENDED',
  terminatedAt = '2026-05-20',
  reactivate = () => json(RESULT),
  roles = () => json(heldRoles(ROLES)),
  i18n,
  language,
}: Answers = {}): Promise<void> => {
  vi.resetModules();
  accountStatus = status;

  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url).pathname;

    sent.push({
      url,
      method: input.method,
      headers: Object.fromEntries(input.headers),
      // The raw text rather than parsed JSON: this operation carries **no** body, and `.json()` on
      // an empty one rejects — which would make every case fail for a reason unrelated to itself.
      body: await input.clone().text(),
    });

    if (url.endsWith('/me/permissions')) {
      return json({ permissions: [...granted], denied: [], roles: [], isOwner: false, version: 1 });
    }
    if (url.endsWith('/permissions')) return roles();
    if (url.endsWith('/reactivate')) {
      // The server the card is read against, not a fixture frozen in time: a run that succeeds
      // leaves the account on, which is what makes «the plate disappears» observable at all.
      accountStatus = 'ACTIVE';

      return reactivate();
    }
    if (url.endsWith(`/employees/${USER}`)) {
      return json({
        ...PROFILE,
        terminatedAt,
        ...(accountStatus === 'absent' ? {} : { status: accountStatus }),
      });
    }

    return json({ status: 'ok' });
  });

  const { renderApp } = await import('../support/render-app.util.js');

  renderApp({
    path: `/admin/members/${USER}`,
    status: 'authenticated',
    ...(i18n === undefined ? {} : { i18n }),
    ...(language === undefined ? {} : { language }),
  });
};

const openDialog = async (user: UserEvent): Promise<HTMLElement> => {
  await user.click(await screen.findByRole('button', { name: /^members\.reactivate\.trigger$/ }));

  return await screen.findByRole('dialog');
};

const confirm = async (user: UserEvent, dialog: HTMLElement): Promise<void> => {
  await user.click(within(dialog).getByRole('button', { name: /^members\.reactivate\.submit$/ }));
};

/**
 * Presses the button under the report.
 *
 * Two controls read «close» on that face — the header cross and the button beneath the report, which
 * share a label on purpose — so the one being aimed at is named by position rather than by a query
 * that would have to be ambiguous.
 */
const closeReport = async (user: UserEvent, dialog: HTMLElement): Promise<void> => {
  const closers = within(dialog).getAllByRole('button', { name: /^members\.reactivate\.close$/ });

  await user.click(closers[closers.length - 1] as HTMLElement);
};

const callsTo = (suffix: string): Call[] => sent.filter((call) => call.url.endsWith(suffix));

beforeEach(() => {
  sent = [];
  accountStatus = 'SUSPENDED';
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('the personnel card of an account that is switched off', () => {
  it('says so, and says since when', async () => {
    await startAt();

    expect(await screen.findByText(/^employee\.suspended\.title$/)).toBeInTheDocument();
    expect(screen.getByText(/^employee\.suspended\.since$/)).toBeInTheDocument();
  });

  it('says nothing of the sort about an account that is on', async () => {
    await startAt({ status: 'ACTIVE', terminatedAt: null });

    // The record has arrived — otherwise the absence below would be about a card still loading.
    await screen.findByLabelText(/employee\.firstName/);

    expect(screen.queryByText(/^employee\.suspended\.title$/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^members\.reactivate\.trigger$/ })).toBeNull();
  });

  /**
   * Decision D4, as the case that makes it a rule rather than a preference.
   *
   * `terminatedAt` is an editable HR field under `employee:update`, and an administrator entering a
   * leaving date in advance — the ordinary way of recording a notice period — would otherwise see a
   * working account rendered as disabled, with a button offering to bring back somebody who has not
   * left. The state of the **account** is `status` and nothing else.
   */
  it('does not read a leaving date as the account being off', async () => {
    await startAt({ status: 'ACTIVE', terminatedAt: '2026-05-20' });

    await screen.findByLabelText(/employee\.firstName/);

    expect(screen.queryByText(/^employee\.suspended\.title$/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^members\.reactivate\.trigger$/ })).toBeNull();
  });

  /**
   * And the mirror image: the state is off, the personnel record carries no date at all — a caller
   * without `employee:view_personal_data` receives no employment keys — and the plate still appears,
   * because what it is about is the account rather than the paperwork.
   */
  it('says the account is off even when no leaving date was sent with it', async () => {
    await startAt({ terminatedAt: null });

    expect(await screen.findByText(/^employee\.suspended\.title$/)).toBeInTheDocument();
    expect(screen.queryByText(/^employee\.suspended\.since$/)).toBeNull();
  });

  /**
   * Fail-closed. The key is sent only to a holder of `user:read` and to the person themselves; its
   * absence means «you may not see this», never «the account is fine» (`docs/api/openapi.yaml`,
   * `EmployeeProfile.status`). Inventing «active» from silence would be the client deciding a
   * question the server declined to answer.
   */
  it('says nothing about a state the server did not send', async () => {
    await startAt({ status: 'absent', granted: ['employee:read', 'user:reactivate'] });

    await screen.findByLabelText(/employee\.firstName/);

    expect(screen.queryByText(/^employee\.suspended\.title$/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^members\.reactivate\.trigger$/ })).toBeNull();
  });
});

describe('the reactivation control', () => {
  it('is not offered at all to somebody without the permission', async () => {
    // `user:read` is granted so that the state the plate reads is present: without it the control
    // would be absent for the wrong reason, and the case would assert nothing about the permission
    // it is named after.
    await startAt({ granted: ['employee:read', 'user:read'] });

    // Both preconditions of the absence: the plate proves the state arrived and the card knows the
    // account is off, so what is missing is the permission and nothing else.
    await screen.findByText(/^employee\.suspended\.title$/);

    expect(screen.queryByRole('button', { name: /^members\.reactivate\.trigger$/ })).toBeNull();
    // The heading too: a section with nothing under it announces an action to somebody who cannot
    // take it, which is the opposite of what hiding the button is for.
    expect(screen.queryByRole('heading', { name: /^members\.reactivate\.title$/ })).toBeNull();
  });

  it('is not offered while the record it reads the state from is still on its way', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answered = startAt();

    // A `Promise` the profile route awaits, installed by wrapping the stub after it is in place: a
    // single held `Response` cannot serve both of `StrictMode`'s mounts, since a body reads once.
    const stubbed = globalThis.fetch as typeof globalThis.fetch;

    vi.stubGlobal('fetch', async (input: Request) => {
      if (new URL(input.url).pathname.endsWith(`/employees/${USER}`)) await gate;

      return await stubbed(input);
    });

    await answered;
    await screen.findByTestId('text-skeleton');
    expect(screen.queryByRole('button', { name: /^members\.reactivate\.trigger$/ })).toBeNull();

    release();

    // CONTROL: the same mount, the same permission — only the document changed.
    expect(
      await screen.findByRole('button', { name: /^members\.reactivate\.trigger$/ }),
    ).toBeInTheDocument();
  });
});

describe('the reactivation dialog', () => {
  /**
   * Criterion 5. Deactivation does not take roles away — «доступ закрыт статусом и версией прав, а
   * роли — состав, который нечем восстановить» (STORY-012-06) — so reactivation hands back the whole
   * of somebody's former power in one call, without a second decision anywhere. Naming the roles
   * before the button is what separates «bring Ivan back» from «bring an administrator back».
   */
  it('names the roles that come back with the account, before the button', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openDialog(user));

    expect(await dialog.findByText(/^members\.reactivate\.roles\.named$/)).toBeInTheDocument();
    expect(dialog.getByText(/^members\.reactivate\.restored\.signIn$/)).toBeInTheDocument();
  });

  it('says so when the account holds no role at all', async () => {
    const user = userEvent.setup();

    await startAt({ roles: () => json(heldRoles([])) });

    const dialog = within(await openDialog(user));

    expect(await dialog.findByText(/^members\.reactivate\.roles\.none$/)).toBeInTheDocument();
  });

  /**
   * Reading somebody else's roles takes `permission:override_read`, which a holder of
   * `user:reactivate` need not have. The dialog then says the list cannot be shown — and, crucially,
   * does not spend a request that would always be refused (`ux-architecture.md`, принцип 6).
   */
  it('does not pretend to know the roles it may not read, and does not ask', async () => {
    const user = userEvent.setup();

    await startAt({ granted: ['employee:read', 'user:read', 'user:reactivate'] });

    const dialog = within(await openDialog(user));

    expect(dialog.getByText(/^members\.reactivate\.roles\.hidden$/)).toBeInTheDocument();
    expect(dialog.queryByText(/^members\.reactivate\.roles\.named$/)).toBeNull();
    expect(callsTo(`/users/${USER}/permissions`)).toEqual([]);
  });

  it('says the roles could not be read when the request for them fails', async () => {
    const user = userEvent.setup();

    await startAt({ roles: () => problem('user_forbidden', 403) });

    const dialog = within(await openDialog(user));

    expect(
      await dialog.findByText(/^members\.reactivate\.roles\.unavailable$/),
    ).toBeInTheDocument();
  });

  /**
   * Criterion 4, stated before the button as well as after it. What people are surprised by later is
   * exactly this list, and an administrator should be able to decide from the dialog rather than
   * from the report.
   */
  it('lists what reactivation will not bring back, before the button that runs it', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openDialog(user));

    expect(dialog.getByText(/^members\.reactivate\.limits\.teams$/)).toBeInTheDocument();
    expect(dialog.getByText(/^members\.reactivate\.limits\.projects$/)).toBeInTheDocument();
    expect(dialog.getByText(/^members\.reactivate\.limits\.vaults$/)).toBeInTheDocument();
  });

  /**
   * The request itself, and the header the contract makes mandatory.
   *
   * `components.parameters.IdempotencyKey` is `required: true` on `reactivateUser`, so the generated
   * types demand it at the call site; this is the assertion that the call site satisfies them rather
   * than casting past them.
   */
  it('posts the reactivation with an idempotency key and no body, then reports what did not return', async () => {
    const user = userEvent.setup();

    await startAt();

    await confirm(user, await openDialog(user));

    await waitFor(() => {
      expect(callsTo('/reactivate')).toHaveLength(1);
    });

    const [call] = callsTo('/reactivate');

    expect(call?.url).toBe(`/api/v1/users/${USER}/reactivate`);
    expect(call?.method).toBe('POST');
    expect(call?.headers['idempotency-key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The operation declares no request body; sending one would be inventing a contract.
    expect(call?.body).toBe('');

    // The dialog stays open and says what came back — and, at greater length, what did not.
    expect(await screen.findByText(/^members\.reactivate\.done\.title$/)).toBeInTheDocument();
    expect(screen.getByText(/^members\.reactivate\.notRestored\.title$/)).toBeInTheDocument();
    expect(screen.getByText(/^members\.reactivate\.limits\.teams$/)).toBeInTheDocument();
    expect(screen.getByText(/^members\.reactivate\.limits\.projects$/)).toBeInTheDocument();
    expect(screen.getByText(/^members\.reactivate\.limits\.vaults$/)).toBeInTheDocument();
  });

  /**
   * Criterion 3, decision D3: the report **is** the signal, and there is exactly one. A toast beside
   * it would be two signals for one action (`rules/errors-and-toasts.mdc` §2) — and this report does
   * not fit in a toast, which is the reason the decision went that way.
   */
  it('reports in the dialog and raises no toast', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);

    await confirm(user, dialog);

    await within(dialog).findByText(/^members\.reactivate\.done\.title$/);

    // Toasts are counted as rendered notifications, not through `queryByRole`: Mantine gives every
    // `Alert` `role="alert"` by default and this report contains two, so a role query would find the
    // report and call it a toast. The **premise** is that the surface they would appear in is
    // mounted at all — without it this case would pass just as happily on a page with no toaster.
    expect(
      document.querySelectorAll('.mantine-Notifications-root').length,
      'the toast surface is not mounted — this case would pass on any page',
    ).toBeGreaterThan(0);
    expect(document.querySelectorAll('.mantine-Notification-root')).toHaveLength(0);
  });

  /**
   * The half a server may report and an interface usually gets wrong: two tabs, or two
   * administrators, and the second call finds an account that is already on. It wrote nothing, and
   * it is not a refusal (criterion 7).
   */
  it('treats an account that was already on as an outcome, not as a failure', async () => {
    const user = userEvent.setup();

    await startAt({ reactivate: () => json({ ...RESULT, alreadyActive: true }) });

    await confirm(user, await openDialog(user));

    expect(await screen.findByText(/^members\.reactivate\.already\.title$/)).toBeInTheDocument();
    expect(screen.getByText(/^members\.reactivate\.already\.description$/)).toBeInTheDocument();
    expect(screen.queryByText(/^members\.reactivate\.done\.title$/)).toBeNull();
    expect(screen.queryByText(/^members\.reactivate\.failed\.title$/)).toBeNull();
  });

  /**
   * And the future the field exists to describe: `membershipsRestored` is `false` today and says so
   * in the contract, but the client reads it rather than asserting it. If the server ever does bring
   * memberships back, this stops telling people it did not.
   */
  it('drops the «what did not return» half when the server says memberships did return', async () => {
    const user = userEvent.setup();

    await startAt({ reactivate: () => json({ ...RESULT, membershipsRestored: true }) });

    await confirm(user, await openDialog(user));

    expect(await screen.findByText(/^members\.reactivate\.done\.title$/)).toBeInTheDocument();
    expect(screen.queryByText(/^members\.reactivate\.notRestored\.title$/)).toBeNull();
  });

  /**
   * Criterion 6. The permission is a hint; the authority is the answer, and a refusal has to be
   * visible from inside the dialog: it is `aria-modal="true"`, so for a screen reader nothing outside
   * it exists while it is open. The mutation declares its own `onError` so the global toast stands
   * aside rather than adding a second signal.
   */
  it('shows a refusal inside the dialog, exactly once', async () => {
    const user = userEvent.setup();

    await startAt({ reactivate: () => problem('user_forbidden', 403) });

    const dialog = await openDialog(user);

    await confirm(user, dialog);

    expect(
      await within(dialog).findByText(/^members\.reactivate\.failed\.title$/),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/^errors\.code\.user_forbidden$/)).toHaveLength(1);
  });

  /** Criterion 8: somebody of another organization is a 404, and reads as «not found». */
  it('shows the not-found refusal for an id of another organization', async () => {
    const user = userEvent.setup();

    await startAt({ reactivate: () => problem('user_not_found', 404) });

    const dialog = await openDialog(user);

    await confirm(user, dialog);

    expect(await within(dialog).findByText(/^errors\.code\.user_not_found$/)).toBeInTheDocument();
  });

  /**
   * Why the card is refreshed on close rather than on success, asserted as the two facts that make
   * it necessary.
   *
   * The section this dialog lives in is drawn only while the account is off. Invalidating in
   * `onSuccess` would refetch the record, flip the state to active, and unmount the section — taking
   * the report off the screen in the same commit that produced it.
   */
  it('refreshes the card when the dialog closes, not while the report is on screen', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);

    await confirm(user, dialog);
    await within(dialog).findByText(/^members\.reactivate\.done\.title$/);

    const readsBefore = callsTo(`/employees/${USER}`).length;

    // The report survives: nothing was refetched while it was being read.
    expect(within(dialog).getByText(/^members\.reactivate\.notRestored\.title$/)).toBeVisible();
    expect(callsTo(`/employees/${USER}`)).toHaveLength(readsBefore);

    await closeReport(user, dialog);

    // And now it is: the plate goes, the control goes, and both because the record was read again.
    await waitFor(() => {
      expect(callsTo(`/employees/${USER}`).length).toBeGreaterThan(readsBefore);
    });
    await waitFor(() => {
      expect(screen.queryByText(/^employee\.suspended\.title$/)).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /^members\.reactivate\.trigger$/ })).toBeNull();
  });

  /** A cancelled dialog changed nothing, so there is nothing to re-read. */
  it('does not refetch the record when the dialog is dismissed without running', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);
    const readsBefore = callsTo(`/employees/${USER}`).length;

    await user.click(within(dialog).getByRole('button', { name: /^members\.reactivate\.cancel$/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(callsTo(`/employees/${USER}`)).toHaveLength(readsBefore);
    expect(callsTo('/reactivate')).toEqual([]);
  });

  it('starts from the form again on the next open', async () => {
    const user = userEvent.setup();

    // The account stays off, so the section outlives the run and can be opened a second time — the
    // shape a failed attempt takes, and the one where a stale report would be a lie about this run.
    await startAt({ reactivate: () => problem('user_forbidden', 403) });

    const dialog = await openDialog(user);

    await confirm(user, dialog);
    await within(dialog).findByText(/^members\.reactivate\.failed\.title$/);

    await user.click(within(dialog).getByRole('button', { name: /^members\.reactivate\.cancel$/ }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    const reopened = within(await openDialog(user));

    expect(reopened.queryByText(/^members\.reactivate\.failed\.title$/)).toBeNull();
    expect(reopened.getByRole('button', { name: /^members\.reactivate\.submit$/ })).toBeEnabled();
  });

  it('moves the focus into itself', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);

    await waitFor(() => {
      // The header cross: the first tabbable node of the dialog, and the one that changes nothing.
      expect(expectFocusInside(dialog)).toHaveAccessibleName(/^members\.reactivate\.close$/);
    });
  });

  it('keeps the focus inside itself, in both directions', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);

    expect(
      await focusEscapes(user, dialog, await screen.findByLabelText(/employee\.firstName/)),
    ).toEqual([]);
  });

  it('wraps at both ends rather than swallowing the key', async () => {
    const user = userEvent.setup();

    await startAt();

    expect(await tabWrapFailures(user, await openDialog(user))).toEqual([]);
  });

  /**
   * `Esc` abandons, and abandoning is all it does. The absence of the request is the assertion
   * rather than decoration: once the dialog is gone, «Escape closed it» and «Escape confirmed it»
   * look identical from outside, and the second would hand somebody's access back from a keystroke
   * aimed at the page behind.
   */
  it('abandons on Escape without reactivating anybody, and gives the focus back', async () => {
    const user = userEvent.setup();

    await startAt();

    const trigger = await screen.findByRole('button', {
      name: /^members\.reactivate\.trigger$/,
    });

    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expectFocusReturnedTo(trigger, 'the control that opens the reactivation dialog');
    });
    expect(callsTo('/reactivate')).toEqual([]);
  });

  it('returns focus to the trigger when it closes with nothing done', async () => {
    const user = userEvent.setup();

    await startAt();

    const trigger = await screen.findByRole('button', {
      name: /^members\.reactivate\.trigger$/,
    });

    await user.click(trigger);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: /^members\.reactivate\.cancel$/,
      }),
    );

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expectFocusReturnedTo(trigger, 'the control that opens the reactivation dialog');
    });
  });

  /**
   * The other half of the focus decision, and the one a copy of the 2FA-reset dialog would get
   * wrong. After a successful run the section this dialog was opened from stops being drawn — the
   * account is on — so «return the focus to the trigger» would return it to a detached node, which
   * is focus on `<body>`: a keyboard user dumped at the top of the shell. It goes to the page
   * heading instead, where the route announcer already sends it when what a page is about changes
   * (`rules/a11y.mdc` §21). The lesson is `DisableTotp`'s, restated because the condition is the
   * same one.
   */
  it('moves the focus to the page heading when the run has removed the trigger', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);

    await confirm(user, dialog);
    await within(dialog).findByText(/^members\.reactivate\.done\.title$/);

    await closeReport(user, dialog);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    const heading = screen.getByRole('heading', { level: 1, name: /^employee\.title$/ });

    await waitFor(() => {
      expectFocusReturnedTo(heading, 'the heading of the page whose subject has just changed');
    });
    // The premise: the trigger really is gone, so this is not merely a preference about focus.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^members\.reactivate\.trigger$/ })).toBeNull();
    });
  });
});

/**
 * axe over **both** faces of the dialog.
 *
 * The report is not a variation on the confirmation: it is an `Alert` and a `List` where the
 * consequence list and the buttons were, and scanning only the state a case happens to leave behind
 * is how the half nobody looks at ships with a violation.
 */
describe.each([
  ['while the confirmation is on screen', false],
  ['while the report is on screen', true],
] as const)('the reactivation dialog has no accessibility violation %s', (_case, runFirst) => {
  it('passes axe', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);

    if (runFirst) {
      await confirm(user, dialog);
      await within(dialog).findByText(/^members\.reactivate\.done\.title$/);
    } else {
      await within(dialog).findByText(/^members\.reactivate\.roles\.named$/);
    }

    // `button-name` is the control: it is the rule a Mantine close cross fails without a label.
    expect(await axeViolationsIn(dialog, { modal: true, control: 'button-name' })).toEqual([]);
  });
});

/** The plate is on the page rather than in a dialog, so it is scanned where it lives. */
describe('the account-state plate', () => {
  it('passes axe', async () => {
    await startAt();

    await screen.findByText(/^employee\.suspended\.title$/);

    expect(await axeViolationsIn(document.body, { control: 'button-name' })).toEqual([]);
  });
});

/**
 * The properties `cimode` cannot state.
 *
 * Every assertion above matches a **key**, which is what makes them readable and what makes them
 * blind: under `cimode` `t(key)` returns the key, so a label that was never passed through `t()` at
 * all is indistinguishable from one that was, and a sentence with an interpolation renders its key
 * whether or not the variable inside it still has that name.
 *
 * So both catalogues are rendered for real, and what is asserted is what an administrator has to be
 * able to read before pressing the button: **whose** account this is, **which roles** come back with
 * it, and that the memberships do not.
 */
describe.each(['en', 'ru'] as const)('the reactivation dialog in %s', (language) => {
  it('names the person, the roles and what stays revoked', async () => {
    const user = userEvent.setup();
    const i18n = SharedI18n.createI18n(language);

    await startAt({ i18n, language });

    await user.click(
      await screen.findByRole('button', { name: i18n.t('members.reactivate.trigger') }),
    );

    const dialog = within(await screen.findByRole('dialog'));

    // Whose account: the sentence carries the address, and an interpolation renamed on one side
    // would leave `{{email}}` on screen instead.
    expect(dialog.getByText(new RegExp(EMAIL))).toBeInTheDocument();
    // Which roles, by name — the whole point of criterion 5, and invisible under `cimode`.
    expect(await dialog.findByText(new RegExp(ROLES[0].name))).toBeInTheDocument();
    expect(dialog.getByText(new RegExp(ROLES[1].name))).toBeInTheDocument();
    // What does not come back, as the sentence the catalogue carries — so a key that exists but was
    // never rendered fails here rather than passing on its own name.
    expect(dialog.getByText(i18n.t('members.reactivate.limits.teams'))).toBeInTheDocument();
    // Nothing left un-interpolated, and no raw key on screen: `t()` returns the key itself when the
    // catalogue has no entry, which is the one failure a `cimode` suite can never see.
    expect(dialog.queryByText(/\{\{/)).toBeNull();
    expect(dialog.queryByText(/members\.reactivate\./)).toBeNull();
  });

  it('names the account state on the card', async () => {
    const i18n = SharedI18n.createI18n(language);

    await startAt({ i18n, language });

    expect(await screen.findByText(i18n.t('employee.suspended.title'))).toBeInTheDocument();
    expect(screen.queryByText(/employee\.suspended\./)).toBeNull();
    expect(screen.queryByText(/\{\{/)).toBeNull();
  });
});
