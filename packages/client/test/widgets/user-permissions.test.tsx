import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type i18n as I18n } from 'i18next';

import { SharedI18n } from '@shared';

/**
 * The permissions tab of a personnel card — `/admin/members/{userId}?tab=roles`.
 *
 * The properties, and the first one is the reason the screen exists at all:
 *
 *   * **it decides nothing.** Every row shows the `source` the server assembled from the one
 *     capability ladder the request guard also walks (`permission-model.md` §«Слой 5» — «одна
 *     лестница, три потребителя»). The cases below hand the screen sources that could not be
 *     derived from what else is in the row, so a client that recomputed them would disagree here;
 *   * **three positions, and each says what the other two would mean.** «Back to inherited» is only
 *     honest if the row can say what inherited *is* — which is why `roleIds` arrives under a DENY
 *     too, and why «inherits nothing» and «inherits from Manager» are asserted as different screens;
 *   * **the write is pessimistic, so the screen re-reads.** The assertion is a **second GET**, never
 *     «the mutation was called»: a mutation that fires and never invalidates leaves a control
 *     showing the old position with a green toast over it, and that is invisible to a test that
 *     stops at the request;
 *   * **the owner is a state, not a disabled button.** Nothing is offered, and the reason is said
 *     once above the table rather than three hundred times inside it;
 *   * **one action, one signal.** A refusal of the write is rendered inside the dialog — which is
 *     `aria-modal`, so a toast outside it does not exist for its reader — and the mutation's local
 *     `onError` exists to make the global toast stand aside rather than to add a second one.
 */

const USER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af1';
const MANAGER_ROLE = '018f4a3b-2c1d-7a41-9f00-000000000ma1';
const DEVELOPER_ROLE = '018f4a3b-2c1d-7a41-9f00-000000000de1';

/** Everything the tab needs to be visible and useful. */
const ADMIN = ['employee:read', 'permission:override_read', 'permission:override'];

let sent: { url: string; method: string; body: unknown }[];

const platformFetch = globalThis.fetch;

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const noContent = (): Response => new Response(null, { status: 204 });

/**
 * `application/problem+json` as the server produces it. `reason` is an RFC 9457 extension member and
 * is present exactly when the permission layer is what refused (`problem.serializer.ts`).
 */
const problem = (code: string, status: number, reason?: string): Response =>
  new Response(
    JSON.stringify({
      type: `https://bad-crm.dev/problems/${code}`,
      title: code,
      status,
      code,
      requestId: 'req-1',
      ...(reason === undefined ? {} : { reason }),
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );

const PROFILE = {
  userId: USER,
  email: 'ivan@example.test',
  firstName: 'Ivan',
  lastName: 'Petrov',
  jobTitle: 'Backend engineer',
  department: 'Platform',
  managerId: null,
  timezone: 'Europe/Moscow',
  skills: [],
};

/**
 * Four keys, one per shape the screen has to draw — a personal ALLOW, a personal DENY over a role, a
 * plain inheritance, and a key nobody granted.
 *
 * Four rather than the whole catalogue, and that is a fixture decision rather than a claim about the
 * contract: the response really does carry every key (`openapi.yaml` → `UserPermissions`), and the
 * screen renders what it is sent. Three hundred rows of radios in jsdom would make every case in
 * this file a second slower and would assert nothing the four do not.
 */
const PERMISSIONS = {
  userId: USER,
  isOwner: false,
  version: 7,
  roles: [
    { roleId: MANAGER_ROLE, key: 'manager', name: 'Manager' },
    { roleId: DEVELOPER_ROLE, key: 'developer', name: 'Developer' },
  ],
  permissions: [
    {
      key: 'task:update',
      allowed: true,
      source: 'OVERRIDE_ALLOW',
      roleIds: [],
      override: {
        effect: 'ALLOW',
        reason: 'covering billing while Pyotr is on leave',
        grantedById: null,
        grantedAt: '2026-08-01T09:00:00.000Z',
        expiresAt: '2026-09-15T00:00:00.000Z',
      },
    },
    {
      key: 'task:delete',
      allowed: false,
      source: 'OVERRIDE_DENY',
      // Reported under a DENY on purpose: this is what «back to inherited» would restore.
      roleIds: [MANAGER_ROLE],
      override: {
        effect: 'DENY',
        reason: 'deleted a sprint by accident in July',
        grantedById: null,
        grantedAt: '2026-07-20T09:00:00.000Z',
        expiresAt: null,
      },
    },
    { key: 'task:read', allowed: true, source: 'ROLE', roleIds: [MANAGER_ROLE], override: null },
    {
      key: 'vault_item:export',
      allowed: false,
      source: 'NOT_GRANTED',
      roleIds: [],
      override: null,
    },
  ],
};

interface Answers {
  readonly granted?: readonly string[];
  readonly permissions?: () => Response | Promise<Response>;
  readonly write?: () => Response;
  readonly remove?: () => Response;
  readonly path?: string;
  readonly i18n?: I18n;
  readonly language?: string;
}

const startAt = async ({
  granted = ADMIN,
  permissions = () => json(PERMISSIONS),
  write = () => noContent(),
  remove = () => noContent(),
  path = `/admin/members/${USER}?tab=roles`,
  i18n,
  language,
}: Answers = {}): Promise<void> => {
  vi.resetModules();
  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url).pathname;
    const body = input.method === 'PUT' ? await input.clone().json() : undefined;

    sent.push({ url: decodeURIComponent(url), method: input.method, body });

    if (url.endsWith('/me/permissions')) {
      return json({ permissions: [...granted], denied: [], roles: [], isOwner: false, version: 1 });
    }
    if (url.includes('/permission-overrides/')) {
      return input.method === 'DELETE' ? remove() : write();
    }
    if (url.endsWith(`/users/${USER}/permissions`)) return await permissions();
    if (url.endsWith(`/employees/${USER}`)) return json(PROFILE);

    return json({ status: 'ok' });
  });

  /**
   * The toaster is emptied through the **fresh** module graph, and it is not housekeeping.
   *
   * `vi.resetModules()` rebuilds the client's own modules — including the `live` id set inside
   * `shared/ui/toaster` — but `@mantine/notifications` is an external dependency and its store
   * survives the reset. A toast left behind by an earlier case keeps its id occupied, `show` with
   * that id is ignored, and the next case asserts an absence it did not cause. Measured: «reports a
   * refused removal» passed alone and failed in the file, behind the success toast of the case
   * before it, which shares the id on purpose (one control, one signal).
   */
  const { SharedUi } = await import('@shared');

  SharedUi.notify.clear();

  const { renderApp } = await import('../support/render-app.util.js');

  renderApp({
    path,
    status: 'authenticated',
    ...(i18n === undefined ? {} : { i18n }),
    ...(language === undefined ? {} : { language }),
  });
};

/** How many times the tab has asked what this person may do. */
const reads = (): number =>
  sent.filter((call) => call.method === 'GET' && call.url.endsWith(`/users/${USER}/permissions`))
    .length;

/** The row a key is on, found by the key itself — which is what the row header carries. */
const rowOf = async (key: string): Promise<HTMLElement> => {
  const cell = await screen.findByText(key);
  const row = cell.closest('tr');

  if (row === null) throw new Error(`no row for ${key}`);

  return row;
};

/** Waits for the table, so a case never asserts an absence that is merely «not yet». */
const table = async (): Promise<HTMLElement> => await screen.findByRole('table');

const choose = async (user: UserEvent, key: string, choice: string): Promise<void> => {
  const row = await rowOf(key);

  await user.click(within(row).getByRole('radio', { name: `permissions.choice.${choice}` }));
};

/** Fills the dialog and submits it. */
const submitOverride = async (
  user: UserEvent,
  {
    reason = 'covering billing while Pyotr is on leave',
    on,
  }: { reason?: string; on?: string } = {},
): Promise<HTMLElement> => {
  const dialog = await screen.findByRole('dialog');
  const scope = within(dialog);

  await user.type(scope.getByLabelText(/permissions\.form\.reasonLabel/), reason);

  if (on !== undefined) {
    // `fireEvent` rather than `user.type`: a `type="date"` input takes a whole value, and typing
    // into one character by character is a browser behaviour jsdom does not have.
    fireEvent.change(scope.getByLabelText(/permissions\.form\.expiresLabel/), {
      target: { value: on },
    });
  }

  await user.click(scope.getByRole('button', { name: /permissions\.form\.submit/ }));

  return dialog;
};

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('the permissions tab', () => {
  it('is not offered to somebody who may not read exceptions, and asks for nothing', async () => {
    // `user:read` is granted alongside `employee:read` so the sidebar has a fact to prove: a link
    // gated on it can only be on screen once the caller's own rights have genuinely **landed** and
    // been read — `can()` fails closed while they are still in flight, exactly as it does once they
    // arrive and refuse. Without this the case would pass identically if `/me/permissions` were
    // never asked at all, which is a different and much worse defect than «the tab is hidden».
    await startAt({ granted: ['employee:read', 'user:read'] });

    await screen.findByLabelText(/employee\.firstName/);
    // Both preconditions of the absence, so neither can be what produced it: the card has rendered,
    // and the permissions have arrived — the sidebar entry proves it.
    expect(await screen.findAllByRole('link', { name: /nav\.adminMembers/ })).not.toHaveLength(0);

    expect(screen.queryByRole('tab', { name: /permissions\.tab/ })).toBeNull();
    expect(
      reads(),
      'a query behind a tab nobody may open is a guaranteed 403, twice, with a retry',
    ).toBe(0);
  });

  it('is offered with the permission — same mount, one key different', async () => {
    await startAt();

    expect(await screen.findByRole('tab', { name: /permissions\.tab/ })).toBeInTheDocument();
    await table();
    expect(reads()).toBeGreaterThan(0);
  });

  it('falls back to the profile when the address asks for a tab this caller has not got', async () => {
    // The address is a link somebody shared. «You may not read this» is not what the page behind it
    // is: the personnel record is self-service, and a 403 screen would lock people out of their own.
    await startAt({ granted: ['employee:read'] });

    expect(await screen.findByLabelText(/employee\.firstName/)).toBeInTheDocument();
  });

  it('puts every permission in one of three positions and names what decided it', async () => {
    await startAt();
    await table();

    const allowed = within(await rowOf('task:update'));
    const denied = within(await rowOf('task:delete'));
    const inherited = within(await rowOf('task:read'));
    const ungranted = within(await rowOf('vault_item:export'));

    // The position — read off the exception, which is what an administrator controls.
    expect(allowed.getByRole('radio', { name: 'permissions.choice.allow' })).toBeChecked();
    expect(denied.getByRole('radio', { name: 'permissions.choice.deny' })).toBeChecked();
    expect(inherited.getByRole('radio', { name: 'permissions.choice.inherited' })).toBeChecked();
    expect(ungranted.getByRole('radio', { name: 'permissions.choice.inherited' })).toBeChecked();

    // The source — the server's word, and the reason `task:read` and `vault_item:export` are not
    // the same row despite sitting in the same position.
    expect(allowed.getByText('permissions.source.overrideAllow')).toBeInTheDocument();
    expect(denied.getByText('permissions.source.overrideDeny')).toBeInTheDocument();
    expect(inherited.getByText('permissions.source.role')).toBeInTheDocument();
    expect(ungranted.getByText('permissions.source.notGranted')).toBeInTheDocument();
  });

  it('warns beside a dangerous key’s name, and only beside one', async () => {
    await startAt();
    await table();

    // `vault_item:export` is `dangerous: true` in the shared catalogue; `task:read` sits in the
    // same response and is not — the pair is the negative control, so the warning is shown to be
    // about the flag on this one key and not a decoration on every row.
    expect(
      within(await rowOf('vault_item:export')).getByText('permissions.dangerous'),
    ).toBeInTheDocument();
    expect(within(await rowOf('task:read')).queryByText('permissions.dangerous')).toBeNull();
  });

  it('colours the source badge by whether it grants or refuses, not the same colour throughout', async () => {
    await startAt();
    await table();

    // `task:read` answers through `ROLE` (grants) and `vault_item:export` through `NOT_GRANTED`
    // (refuses) — `PERMISSION_SOURCE_TONE` maps the two to different tones, and the badge is
    // supposed to carry that distinction as a colour and not only as the word inside it.
    const grantedBadge = (await rowOf('task:read')).querySelector<HTMLElement>(
      '.mantine-Badge-root',
    );
    const refusedBadge = (await rowOf('vault_item:export')).querySelector<HTMLElement>(
      '.mantine-Badge-root',
    );

    expect(grantedBadge).not.toBeNull();
    expect(refusedBadge).not.toBeNull();
    expect(grantedBadge?.style.getPropertyValue('--badge-bg')).toBe(
      'var(--mantine-color-teal-light)',
    );
    expect(refusedBadge?.style.getPropertyValue('--badge-bg')).toBe(
      'var(--mantine-color-gray-light)',
    );
  });

  it('says what «inherited» would mean, including under a deny that is overruling it', async () => {
    await startAt();
    await table();

    // A role stands behind the deny — lifting it hands the key back.
    expect(
      within(await rowOf('task:delete')).getByText(/permissions\.inheritsFrom/),
    ).toBeInTheDocument();

    // And here nothing does. Two different futures behind the same word, which is why `roleIds`
    // arrives whatever the source is.
    expect(
      within(await rowOf('vault_item:export')).getByText('permissions.inheritsNothing'),
    ).toBeInTheDocument();
    expect(
      within(await rowOf('task:update')).getByText('permissions.inheritsNothing'),
    ).toBeInTheDocument();
  });

  it('shows the reason and the life of an exception beside it', async () => {
    await startAt();
    await table();

    const allowed = within(await rowOf('task:update'));

    expect(allowed.getByText(/permissions\.exception\.reason/)).toBeInTheDocument();
    expect(allowed.getByText(/permissions\.exception\.expires/)).toBeInTheDocument();

    // An exception with no end says so, rather than leaving the line blank.
    expect(
      within(await rowOf('task:delete')).getByText('permissions.exception.neverExpires'),
    ).toBeInTheDocument();

    // CONTROL: a row without an exception carries none of it.
    expect(within(await rowOf('task:read')).queryByText(/permissions\.exception\./)).toBeNull();
  });

  it('asks for a reason before it writes anything', async () => {
    const user = userEvent.setup();

    await startAt();
    await table();
    await choose(user, 'task:read', 'deny');

    await submitOverride(user, { reason: 'because', on: '2027-01-01' });

    // Inline, at the field — a mandatory reason reported as a toast leaves somebody hunting for
    // what to fix (`rules/errors-and-toasts.mdc` §4).
    expect(
      await within(screen.getByRole('dialog')).findByText('permissions.field.reasonTooShort'),
    ).toBeInTheDocument();
    expect(sent.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('asks for an end date, or for an explicit decision not to have one', async () => {
    const user = userEvent.setup();

    await startAt();
    await table();
    // A DENY starts with no date at all: taking something away is the decision that should carry one.
    await choose(user, 'task:read', 'deny');

    await submitOverride(user);

    const dialog = within(screen.getByRole('dialog'));

    expect(await dialog.findByText('permissions.field.expiryRequired')).toBeInTheDocument();
    expect(sent.some((call) => call.method === 'PUT')).toBe(false);

    // Ticking «until somebody removes it» is that decision, and the date stops being part of the
    // question — the field is no longer editable.
    await user.click(dialog.getByLabelText(/permissions\.form\.neverExpires/));
    expect(dialog.getByLabelText(/permissions\.form\.expiresLabel/)).toBeDisabled();

    await user.click(dialog.getByRole('button', { name: /permissions\.form\.submit/ }));

    await waitFor(() => {
      expect(sent.find((call) => call.method === 'PUT')?.body).toEqual({
        effect: 'DENY',
        reason: 'covering billing while Pyotr is on leave',
        expiresAt: null,
      });
    });
  });

  it('offers thirty days by default when widening, so the cheap path is the reversible one', async () => {
    const user = userEvent.setup();

    await startAt();
    await table();
    await choose(user, 'vault_item:export', 'allow');

    const expected = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    expect(
      within(await screen.findByRole('dialog')).getByLabelText(/permissions\.form\.expiresLabel/),
    ).toHaveValue(expected);
  });

  it('writes the exception with the reason and the day chosen, and then re-reads', async () => {
    const user = userEvent.setup();

    await startAt();
    await table();

    const before = reads();

    await choose(user, 'vault_item:export', 'allow');
    await submitOverride(user, { on: '2027-03-01' });

    await waitFor(() => {
      expect(sent.some((call) => call.method === 'PUT')).toBe(true);
    });

    const put = sent.find((call) => call.method === 'PUT');

    expect(put?.url).toBe(`/api/v1/users/${USER}/permission-overrides/vault_item:export`);
    expect(put?.body).toEqual({
      effect: 'ALLOW',
      reason: 'covering billing while Pyotr is on leave',
      // The start of that day, UTC — the zone the field's own hint names.
      expiresAt: '2027-03-01T00:00:00.000Z',
    });

    // The assertion this case exists for. A pessimistic write owes a re-read: the new `source` of
    // the key is assembled from roles, overrides and ownership by the server, and a mutation that
    // fired without invalidating leaves the old position on screen under a green toast.
    await waitFor(() => {
      expect(reads(), 'onSuccess must invalidate, not merely succeed').toBeGreaterThan(before);
    });

    // The dialog closes on success — and only on success.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('removes the exception when the control goes back to inherited, and then re-reads', async () => {
    const user = userEvent.setup();

    await startAt();
    await table();

    const before = reads();

    await choose(user, 'task:delete', 'inherited');

    await waitFor(() => {
      expect(sent.some((call) => call.method === 'DELETE')).toBe(true);
    });

    expect(sent.find((call) => call.method === 'DELETE')?.url).toBe(
      `/api/v1/users/${USER}/permission-overrides/task:delete`,
    );
    // Nothing is asked for: removing an exception needs no reason, and the row already said what
    // would be inherited once it was gone.
    expect(screen.queryByRole('dialog')).toBeNull();

    await waitFor(() => {
      expect(reads(), 'onSuccess must invalidate, not merely succeed').toBeGreaterThan(before);
    });
  });

  it('offers the owner nothing to take away, and says why once', async () => {
    await startAt({
      permissions: () =>
        json({
          ...PERMISSIONS,
          isOwner: true,
          permissions: PERMISSIONS.permissions.map((state) => ({ ...state, source: 'OWNER' })),
        }),
    });
    await table();

    expect(await screen.findByText('permissions.owner.title')).toBeInTheDocument();

    // A state, not a disabled control: a DENY on the owner is refused by the use-case *and* by a
    // trigger, so a greyed-out radio would be offering an act that cannot happen.
    //
    // Scoped to the panel, and that is not tidiness: the shell's own colour-scheme switcher is a
    // `SegmentedControl` too, so an unscoped query counts five radios that have nothing to do with
    // permissions — and would keep this assertion green if the control came back.
    expect(within(screen.getByRole('tabpanel')).queryAllByRole('radio')).toHaveLength(0);

    // And the answer is still fully readable — which is what a reader came for.
    const row = within(await rowOf('task:update'));

    expect(row.getByText('permissions.choice.allow')).toBeInTheDocument();
    expect(row.getByText('permissions.source.owner')).toBeInTheDocument();
  });

  it('shows the state to a reader who may not write, and offers no control', async () => {
    await startAt({ granted: ['employee:read', 'permission:override_read'] });
    await table();

    expect(await screen.findByText('permissions.readOnly.title')).toBeInTheDocument();
    // Scoped for the same reason as above — the shell has radios of its own.
    expect(within(screen.getByRole('tabpanel')).queryAllByRole('radio')).toHaveLength(0);

    // CONTROL: the table itself is there and populated, so the absence above is about the control.
    expect(
      within(await rowOf('task:delete')).getByText('permissions.source.overrideDeny'),
    ).toBeInTheDocument();
  });

  it('shows a refusal once, inside the dialog, and keeps what was typed', async () => {
    const user = userEvent.setup();

    await startAt({ write: () => problem('self_lockout', 409, 'self_lockout') });
    await table();

    await choose(user, 'task:read', 'deny');
    await submitOverride(user, { on: '2027-03-01' });

    const dialog = await screen.findByRole('dialog');

    expect(await within(dialog).findByText(/permissions\.form\.refused/)).toBeInTheDocument();
    // One logical action, one signal: the sentence appears in the dialog and nowhere else. The
    // dialog is `aria-modal`, so a toast in the page corner would not exist for its reader — and a
    // toast *plus* this alert would be the duplicate `rules/errors-and-toasts.mdc` §3 forbids.
    expect(screen.getAllByText(/errors\.code\.self_lockout/)).toHaveLength(1);

    // The form survives the refusal: retyping a reason somebody has already thought about is a
    // punishment for the server's answer.
    expect(within(dialog).getByLabelText(/permissions\.form\.reasonLabel/)).toHaveValue(
      'covering billing while Pyotr is on leave',
    );
  });

  it('explains that you cannot hand out what you do not hold', async () => {
    const user = userEvent.setup();

    // The wire code is `user_forbidden` — the permission model's fifteen reasons are deliberately
    // not fifteen codes — and its sentence («no access to this person») is false here: the caller
    // may edit this person. The distinction is in `reason`.
    await startAt({ write: () => problem('user_forbidden', 403, 'permission_not_granted') });
    await table();

    await choose(user, 'vault_item:export', 'allow');
    await submitOverride(user);

    const dialog = within(await screen.findByRole('dialog'));

    expect(await dialog.findByText('permissions.refusal.permissionNotGranted')).toBeInTheDocument();
    expect(screen.queryByText(/errors\.code\.user_forbidden/)).toBeNull();
  });

  it('reports a refused removal where it was clicked — a toast, because there is no dialog', async () => {
    const user = userEvent.setup();

    await startAt({
      remove: () => problem('user_forbidden', 403, 'self_assignment_forbidden'),
    });
    await table();

    await choose(user, 'task:delete', 'inherited');

    expect(
      await screen.findByText('permissions.refusal.selfAssignmentForbidden'),
    ).toBeInTheDocument();
    // Exactly one — the local handler overrides the global toast rather than adding to it.
    expect(screen.getAllByText('permissions.refusal.selfAssignmentForbidden')).toHaveLength(1);
  });

  it('shows a skeleton while the answer is on its way, not an empty table', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await startAt({
      // A fresh `Response` per call behind one gate: `StrictMode` mounts twice, and one `Response`
      // handed to both consumers is a body that can be read once.
      permissions: async () => {
        await gate;

        return json(PERMISSIONS);
      },
    });

    /**
     * Scoped to the panel, and waited for after the tab exists — both halves matter.
     *
     * The card opens on the **profile** while `/me/permissions` is still in flight (the tab cannot
     * be offered before the answer that permits it), and the profile is a column of text fields
     * with a `TextSkeleton` of its own. An unscoped `findByTestId('text-skeleton')` therefore
     * passes on the profile's skeleton and says nothing about this tab: measured, when a defect
     * that removed the skeleton here left this case green.
     */
    await screen.findByRole('tab', { name: /permissions\.tab/ });

    const panel = await screen.findByRole('tabpanel');

    expect(await within(panel).findByTestId('text-skeleton')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();

    release();

    // CONTROL: the same mount resolves into the table, so the skeleton was the loading state and
    // not a screen that never arrives.
    expect(await table()).toBeInTheDocument();
  });

  it('offers a retry when the answer does not come, and recovers', async () => {
    const user = userEvent.setup();
    let recovers = false;

    await startAt({
      // A flag rather than a counter: the query retries once and `StrictMode` mounts twice, so
      // «fail the first attempt» would be repaired by the suite itself.
      permissions: () => (recovers ? json(PERMISSIONS) : problem('user_forbidden', 403)),
    });

    await screen.findByTestId('error-state');

    recovers = true;
    await user.click(screen.getByRole('button', { name: 'common.retry' }));

    expect(await table()).toBeInTheDocument();
  });

  it('says so when the filters leave nothing, rather than showing an empty table', async () => {
    await startAt({ path: `/admin/members/${USER}?tab=roles&q=chimera` });

    expect(await screen.findByText(/permissions\.empty/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('narrows to what the address bar asks for, and puts a new phrase back into it', async () => {
    const user = userEvent.setup();

    const { renderApp } = await (async () => {
      await startAt({ path: `/admin/members/${USER}?tab=roles&q=vault_item` });

      return await import('../support/render-app.util.js');
    })();

    // The filter came from the URL and was applied before anything was typed.
    await table();
    expect(await rowOf('vault_item:export')).toBeInTheDocument();
    expect(screen.queryByText('task:update')).toBeNull();
    expect(renderApp).toBeDefined();

    await user.clear(screen.getByLabelText(/permissions\.searchLabel/));
    await user.type(screen.getByLabelText(/permissions\.searchLabel/), 'task:delete');

    // Debounced, so six keystrokes are not six history entries — and the URL is the source of
    // truth, so the table follows it rather than a second copy of the phrase.
    expect(await rowOf('task:delete')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('vault_item:export')).toBeNull();
    });
  });

  it('moves between the two faces of the card by putting the choice in the address bar', async () => {
    const user = userEvent.setup();

    // Opened on the profile, which is where a card opens for everybody.
    await startAt({ path: `/admin/members/${USER}` });

    expect(await screen.findByLabelText(/employee\.firstName/)).toBeInTheDocument();
    expect(reads(), 'the tab is not mounted, so it has asked for nothing').toBe(0);

    await user.click(await screen.findByRole('tab', { name: /permissions\.tab/ }));

    // The table arrives — and only now is the question asked, which is what `keepMounted={false}`
    // buys: a card opened on the profile does not spend a request on a table nobody looked at.
    await table();
    expect(reads()).toBeGreaterThan(0);

    // And back. The tab is a link somebody can send, so it lives in the URL rather than in state.
    await user.click(screen.getByRole('tab', { name: /employee\.tab\.profile/ }));
    expect(await screen.findByLabelText(/employee\.firstName/)).toBeInTheDocument();
  });

  it('narrows to the exceptions from the switch, not only from a hand-written URL', async () => {
    const user = userEvent.setup();

    await startAt();
    await table();

    await user.click(screen.getByLabelText(/permissions\.onlyExceptions/));

    // The switch writes the filter to the address bar and the table follows the URL — there is no
    // second copy of «are we filtering» for the two to disagree about.
    await waitFor(() => {
      expect(screen.queryByText('task:read')).toBeNull();
    });
    expect(await rowOf('task:delete')).toBeInTheDocument();

    // CONTROL: switching it back brings the unfiltered rows again, so the absence above was the
    // filter rather than a table that had stopped rendering.
    await user.click(screen.getByLabelText(/permissions\.onlyExceptions/));
    expect(await rowOf('task:read')).toBeInTheDocument();
  });

  it('keeps what a refusal interpolates — a wait in seconds is part of the sentence', async () => {
    const user = userEvent.setup();
    // A **real** catalogue, because this is a property `cimode` cannot state: there `t(key, values)`
    // and `t(key)` answer the same string, so an interpolation dropped on the way to the alert would
    // be invisible to every assertion in this file. What is asserted is the sentence an
    // administrator reads — with the number in it, and with no placeholder left behind.
    const i18n = SharedI18n.createI18n('en');

    await startAt({
      i18n,
      language: 'en',
      write: () =>
        new Response(
          JSON.stringify({
            type: 'https://bad-crm.dev/problems/rate-limited',
            title: 'Rate limited',
            status: 429,
            code: 'rate_limited',
            requestId: 'req-1',
          }),
          {
            status: 429,
            headers: { 'content-type': 'application/problem+json', 'retry-after': '30' },
          },
        ),
    });
    await table();

    // Named through the catalogue rather than through a key: in a real language the positions read
    // «Deny» and «Allow», and a regex over the key would find nothing.
    const row = await rowOf('task:read');

    await user.click(within(row).getByRole('radio', { name: i18n.t('permissions.choice.deny') }));

    const dialog = within(await screen.findByRole('dialog'));

    // Anchored regexes rather than the exact strings: Mantine appends an asterisk to the label of a
    // required field, so the accessible name is «Reason *» and an equality match finds nothing.
    await user.type(
      dialog.getByLabelText(new RegExp(`^${i18n.t('permissions.form.reasonLabel')}`)),
      'covering billing while Pyotr is on leave',
    );
    fireEvent.change(
      dialog.getByLabelText(new RegExp(`^${i18n.t('permissions.form.expiresLabel')}`)),
      { target: { value: '2027-03-01' } },
    );
    await user.click(dialog.getByRole('button', { name: i18n.t('permissions.form.submit') }));

    // The refusal did not come from the permission layer, so it keeps its own code — and the wait
    // travels with it. A handler that dropped the values would render «Try again in {{seconds}} s».
    expect(await dialog.findByText(/Try again in 30 s/)).toBeInTheDocument();
    expect(screen.queryByText(/\{\{/)).toBeNull();
  });

  it('filters to the keys carrying an exception when asked', async () => {
    await startAt({ path: `/admin/members/${USER}?tab=roles&exceptions=true` });
    await table();

    expect(await rowOf('task:update')).toBeInTheDocument();
    expect(await rowOf('task:delete')).toBeInTheDocument();
    // CONTROL: the rows that have no exception are the ones that went.
    expect(screen.queryByText('task:read')).toBeNull();
    expect(screen.queryByText('vault_item:export')).toBeNull();
  });
});

/**
 * The control has to be usable without a mouse, and it has to say **which permission** it is about.
 *
 * On a table of three hundred rows, «Deny, radio button, 2 of 3» is not an announcement anybody can
 * act on. `SegmentedControl` renders real radios — arrow keys and the group semantics come from the
 * platform — and the group's own label is what carries the key.
 */
describe('the three-position control from the keyboard', () => {
  it('is reachable, grouped, and moves with the arrow keys', async () => {
    const user = userEvent.setup();

    await startAt();
    await table();

    const group = within(await rowOf('task:read')).getByRole('radiogroup', {
      name: /permissions\.controlLabel/,
    });
    const positions = within(group).getAllByRole('radio');

    expect(positions).toHaveLength(3);

    // Reachable: the checked radio is what `Tab` lands on in a radio group.
    positions[2]?.focus();
    expect(document.activeElement).toBe(positions[2]);

    await user.keyboard('{ArrowRight}');

    // Moving the selection is what asks for an exception — the form is the next step, and the row
    // itself does not change until the server has answered.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

/**
 * axe over **every** state of the screen, not over the one a case happens to leave behind.
 *
 * The table with controls, the owner's read-only table, the dialog and the failed load are four
 * different documents — a scan of one says nothing about the others, which is how the state nobody
 * looks at ships with a violation.
 */
describe.each([
  [
    'with the controls on screen',
    async () => await startAt(),
    async () => await table(),
    ['scope-attr-valid', 'label'],
  ],
  [
    'on the owner, where there are none',
    async () =>
      await startAt({
        permissions: () =>
          json({
            ...PERMISSIONS,
            isOwner: true,
            permissions: PERMISSIONS.permissions.map((state) => ({ ...state, source: 'OWNER' })),
          }),
      }),
    async () => await table(),
    ['scope-attr-valid', 'label'],
  ],
  [
    'for a reader who may not write',
    async () => await startAt({ granted: ['employee:read', 'permission:override_read'] }),
    async () => await table(),
    ['scope-attr-valid', 'label'],
  ],
  [
    'when the answer did not arrive',
    async () => await startAt({ permissions: () => problem('user_forbidden', 403) }),
    async () => await screen.findByTestId('error-state'),
    // No table here — what this state does have is the control that offers a way out of it.
    ['button-name'],
  ],
] as const)(
  'the permissions tab has no accessibility violation %s',
  (_case, start, settle, expected) => {
    it('passes axe', async () => {
      await start();

      /**
       * The state has to be **on screen** before it is scanned, and this line is the whole reason the
       * control below names rules instead of counting them.
       *
       * `findByRole('tabpanel')` resolves as soon as the panel exists — which is while the skeleton is
       * still in it. Scanning there produces a clean, meaningless green about a loading placeholder,
       * for every one of these four cases, and `passes.length > 0` would have been perfectly happy
       * with it. Measured: without this wait the table rules were absent from every scan.
       */
      await settle();

      const panel = await screen.findByRole('tabpanel');

      const { violations, passes } = await axe.run(panel, {
        rules: {
          // Disabled because jsdom cannot answer it, not because the answer is inconvenient — and the
          // premise is checked below rather than claimed. jsdom performs no layout, so every node the
          // rule looks at is judged `hidden` and no pair of colours is ever compared; the stylesheet
          // defining `--bc-*` is never applied either. Left on, the rule would report a permanent
          // green meaning «nothing was measured». Contrast is checked where it can be:
          // `test/theme/tokens.test.ts` computes every token pair in both schemes.
          'color-contrast': { enabled: false },
        },
      });

      expect(violations.map((violation) => violation.id)).toEqual([]);

      /**
       * CONTROL, and named rules rather than a count.
       *
       * Twenty of axe's rules evaluate anything at all in jsdom — the rest need layout and report
       * `hidden` for every node, which is why `color-contrast` is switched off below rather than left
       * to produce a meaningless green. A `passes.length > 0` control would be satisfied by any one
       * of the twenty; naming the three this screen actually depends on is what makes the scan a
       * statement about **this** subtree: the table's structure, the labelling of its inputs, and the
       * ARIA the three-position control declares.
       */
      expect(passes.map((rule) => rule.id)).toEqual(expect.arrayContaining([...expected]));

      // The premise of the exemption: switched on, the rule measures nothing — every outcome it
      // reports is `hidden`, axe's word for «this node has no box», which without layout is all of
      // them. A green from a rule that compared no colours is not evidence of contrast.
      const withContrast = await axe.run(panel, { runOnly: ['color-contrast'] });
      const measured = withContrast.passes
        .flatMap((rule) =>
          rule.nodes.flatMap((node) =>
            node.any.map((check) => (check.data as { messageKey?: string } | null)?.messageKey),
          ),
        )
        .filter((outcome) => outcome !== 'hidden');

      expect(withContrast.violations).toEqual([]);
      expect(measured).toEqual([]);
    });
  },
);

/** The dialog is its own document, and the one with a focus trap to honour. */
describe('the exception dialog', () => {
  it('has no accessibility violation, and traps focus', async () => {
    const user = userEvent.setup();

    await startAt();
    await table();
    await choose(user, 'task:read', 'deny');

    const dialog = await screen.findByRole('dialog');

    const { violations } = await axe.run(dialog, {
      rules: {
        'color-contrast': { enabled: false },
        // A **document-level** heuristic — «two banner landmarks on one page» — that does not model
        // `aria-modal`. While this dialog is open the shell behind it is inert for assistive
        // technology, so its header is not a second banner in any sense a reader experiences. The
        // premise is asserted below rather than claimed.
        'landmark-no-duplicate-banner': { enabled: false },
      },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    for (let step = 0; step < 10; step += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('starts empty again when it is reopened on another permission', async () => {
    const user = userEvent.setup();

    await startAt();
    await table();

    await choose(user, 'task:read', 'deny');
    await user.type(
      within(await screen.findByRole('dialog')).getByLabelText(/permissions\.form\.reasonLabel/),
      'a reason for the first key',
    );
    // Two controls close this dialog and share a label on purpose — the header cross and the
    // button under the form. The last one is the button, and it is the one exercised.
    const closers = within(screen.getByRole('dialog')).getAllByRole('button', {
      name: /permissions\.form\.cancel/,
    });

    await user.click(closers[closers.length - 1] as HTMLElement);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    await choose(user, 'vault_item:export', 'allow');

    // A reason that survived would be a sentence about the previous key, saved against this one.
    expect(
      within(await screen.findByRole('dialog')).getByLabelText(/permissions\.form\.reasonLabel/),
    ).toHaveValue('');
  });
});

/**
 * The three properties `cimode` cannot state.
 *
 * Every assertion above matches a **key**, which is what makes them readable and what makes them
 * blind: `permissions.inheritsFrom` matches whether the sentence names the role, names nothing, or
 * renders `{{roles}}` because the interpolation variable was renamed on one side. So both
 * catalogues are rendered for real, and what is asserted is what an administrator has to be able to
 * read: which role stands behind the key, when the exception ends, and which permission the control
 * is about.
 */
describe.each(['en', 'ru'] as const)('what the tab actually says in %s', (language) => {
  it('names the role, the expiry and the permission the control belongs to', async () => {
    const i18n = SharedI18n.createI18n(language);

    await startAt({ i18n, language });
    await table();

    const denied = within(await rowOf('task:delete'));

    // The role behind the deny, by name — the whole point of `roleIds` arriving under one.
    expect(denied.getByText(/Manager/)).toBeInTheDocument();

    // The reason an administrator wrote, verbatim.
    expect(
      within(await rowOf('task:update')).getByText(/covering billing while Pyotr is on leave/),
    ).toBeInTheDocument();

    // The control says which permission it is about, which is the announcement a reader arriving by
    // `Tab` gets instead of «radio button, 2 of 3».
    expect(
      within(await rowOf('task:read')).getByRole('radiogroup', { name: /task:read/ }),
    ).toBeInTheDocument();

    // Nothing left un-interpolated anywhere: a placeholder on screen is a variable renamed on one
    // side of the catalogue.
    expect(screen.queryByText(/\{\{/)).toBeNull();
  });
});
