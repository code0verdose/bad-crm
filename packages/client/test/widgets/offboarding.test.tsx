import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type i18n as I18n } from 'i18next';

import { SharedI18n } from '@shared';

/**
 * Offboarding from the personnel screen.
 *
 * The properties, and none of them is about the request:
 *
 *   * **the button cannot be clicked through.** This is the one control in the product that ends
 *     somebody's access to everything at once, and it is reached from a row in a list of people —
 *     one mis-click from the wrong person. The **email address** has to be typed back, and it is
 *     the address rather than the surname for a reason the suite asserts below on the record that
 *     decided it: a personnel record nobody has filled in carries `lastName: ''`, so there the
 *     surname confirms nothing — an empty field satisfies it — while the address still does;
 *   * **the confirmation is fail-closed.** Nothing to type back means the button never unlocks,
 *     never the other way round;
 *   * **the report stays on screen**, including the steps this installation could not take and
 *     including «this run changed nothing». Closing on success would hide the only part worth
 *     reading;
 *   * **the control is not offered without the record it needs.** A red button that answers
 *     nothing — while the document loads, and for ever if it 403s — is worse than no button;
 *   * **a refusal is visible where the operation was started.** The dialog is `aria-modal`, so a
 *     toast outside it is not in the accessibility tree a reader is confined to;
 *   * **the modal traps focus and gives it back.** `CLAUDE.md` has carried the focus trap as an
 *     open compliance item since EPIC-007 — «покрыть ловушку фокуса тестом стоит вместе со
 *     следующей модалкой». This is that modal.
 */

const USER = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5af1';
const EMAIL = 'ivan@example.test';

let sent: { url: string; method: string; body: unknown }[];

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
};

const REPORT = {
  userId: USER,
  alreadyDeactivated: false,
  sessionsRevoked: 2,
  teamsLeft: 3,
  pending: ['projectsLeft', 'socketsClosed', 'linksRevoked', 'vaultMembershipsFlagged'],
};

interface Answers {
  /** What `/me/permissions` grants. The default is the caller this file is mostly about. */
  readonly granted?: readonly string[];
  /** What `GET /employees/{id}` answers, evaluated per request so a retry can answer differently. */
  readonly profile?: () => Response | Promise<Response>;
  readonly deactivate?: () => Response;
  /** A real catalogue instead of the suite's `cimode` one — see «in a real language» below. */
  readonly i18n?: I18n;
  readonly language?: string;
}

const startAt = async ({
  granted = ['employee:read', 'user:suspend'],
  profile = () => json(PROFILE),
  deactivate = () => json(REPORT),
  i18n,
  language,
}: Answers = {}): Promise<void> => {
  vi.resetModules();
  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url).pathname;
    const body = input.method === 'POST' ? await input.clone().json() : undefined;

    sent.push({ url, method: input.method, body });

    if (url.endsWith('/me/permissions')) {
      return json({ permissions: [...granted], denied: [], roles: [], isOwner: false, version: 1 });
    }
    if (url.endsWith('/deactivate')) return deactivate();
    if (url.endsWith(`/employees/${USER}`)) return await profile();

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
  await user.click(await screen.findByRole('button', { name: /offboarding\.action/ }));

  return await screen.findByRole('dialog');
};

/** Fills both fields and presses the red button. `confirm` is what gets typed back. */
const submitOffboarding = async (
  user: UserEvent,
  dialog: HTMLElement,
  confirm: string = EMAIL,
): Promise<void> => {
  const scope = within(dialog);

  await user.type(scope.getByLabelText(/offboarding\.reasonLabel/), 'left the company');
  await user.type(scope.getByLabelText(/offboarding\.confirmLabel/), confirm);
  await user.click(scope.getByRole('button', { name: /offboarding\.submit/ }));
};

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('the offboarding dialog', () => {
  it('is offered only to somebody who may deactivate', async () => {
    // `user:read` is granted for the reason it is granted in the two cases below: the sidebar entry
    // it gates is the only thing on screen that proves `/me/permissions` has **answered**. Without
    // it this case is equally green while the query is still in flight — `can('user:suspend')` is
    // `false` then too — and would be asserting nothing about the refusal it is named after.
    await startAt({ granted: ['employee:read', 'user:read'] });

    // Both preconditions of the absence, so that neither can be what produced it: the permissions
    // have arrived, and so has the record the control would confirm against.
    await screen.findByText(/nav\.adminMembers/);
    await screen.findByLabelText(/employee\.firstName/);

    expect(screen.queryByRole('button', { name: /offboarding\.action/ })).toBeNull();
  });

  /**
   * The trigger and the dialog are one decision, not two.
   *
   * A button drawn from `can('user:suspend')` alone is clickable while the document is still on its
   * way, and the dialog it would open is not mounted yet — so it does nothing at all. The control
   * arrives with the record it needs; the CONTROL half of this case is the record arriving, which
   * is what proves the absence above was about the document and not about the permission.
   */
  it('is not offered until the record it confirms against has arrived', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // `user:read` is granted for one reason: the sidebar entry it gates is the only thing on screen
    // that proves the permissions query has **answered**. Without it the assertion below would pass
    // while `can('user:suspend')` was merely still `false`, which is a different screen state and
    // not the one under test.
    await startAt({
      granted: ['employee:read', 'user:suspend', 'user:read'],
      // A fresh `Response` per call, held behind one gate: `StrictMode` mounts twice, and a single
      // `Response` handed to both consumers is a body that can only be read once.
      profile: async () => {
        await gate;

        return json(PROFILE);
      },
    });

    await screen.findByText(/nav\.adminMembers/);
    await screen.findByTestId('text-skeleton');
    expect(screen.queryByRole('button', { name: /offboarding\.action/ })).toBeNull();

    release();

    // CONTROL: the same mount, the same permission — only the document changed.
    expect(await screen.findByRole('button', { name: /offboarding\.action/ })).toBeInTheDocument();
  });

  /**
   * And for ever, when the document never arrives. A screen that failed to load says so once,
   * through `DataState`; a red button left in the header would be a second, contradictory answer to
   * the same condition (`rules/errors-and-toasts.mdc` §2) — and one that leads nowhere.
   */
  it('is not offered when the record cannot be loaded', async () => {
    // A flag rather than a request counter: the query retries once by default and `StrictMode`
    // mounts twice, so «fail the first attempt» would have been repaired by the suite itself.
    let recovers = false;

    await startAt({
      granted: ['employee:read', 'user:suspend', 'user:read'],
      profile: () => (recovers ? json(PROFILE) : problem('user_forbidden', 403)),
    });

    // Same reason as above: the sidebar entry is the proof that the permissions have arrived.
    await screen.findByText(/nav\.adminMembers/);
    await screen.findByTestId('error-state');
    expect(screen.queryByRole('button', { name: /offboarding\.action/ })).toBeNull();

    // CONTROL: retry succeeds and the control appears — the permission was granted all along.
    recovers = true;
    await userEvent.setup().click(screen.getByRole('button', { name: 'common.retry' }));

    expect(await screen.findByRole('button', { name: /offboarding\.action/ })).toBeInTheDocument();
  });

  it('keeps the button unusable until the address is typed back', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openDialog(user));
    const submit = dialog.getByRole('button', { name: /offboarding\.submit/ });

    expect(submit).toBeDisabled();

    await user.type(dialog.getByLabelText(/offboarding\.reasonLabel/), 'left the company');
    expect(submit).toBeDisabled();

    // The wrong person is exactly the mis-click this control exists for.
    await user.type(dialog.getByLabelText(/offboarding\.confirmLabel/), 'sidorov@example.test');
    expect(submit).toBeDisabled();

    await user.clear(dialog.getByLabelText(/offboarding\.confirmLabel/));
    await user.type(dialog.getByLabelText(/offboarding\.confirmLabel/), ' IVAN@example.test ');

    // Trimmed and case-insensitive: the control is «did you mean this person», not a typing test.
    expect(submit).toBeEnabled();
  });

  /**
   * Why it is the address and not the surname, on the record that decided it.
   *
   * `lastName` is empty on a personnel record nobody has filled in — the repository answers with an
   * empty row when no `EmployeeProfile` exists, and neither registration nor accepting an invitation
   * creates one, so this is the ordinary record rather than an edge case. Compared against the
   * surname, the value to type back here is `''`: the red button was armed on open, before anything
   * was typed, on exactly the records where nobody had confirmed anything. The address is on the
   * same document, is never empty, and confirms — which is the entire content of the fix.
   *
   * The names are emptied and the email is left as it is, because that is the shape of the record;
   * the case below states the general property from the other side.
   */
  it('confirms on the address when the record carries no name at all', async () => {
    const user = userEvent.setup();

    await startAt({ profile: () => json({ ...PROFILE, firstName: '', lastName: '' }) });

    const dialog = within(await openDialog(user));
    const submit = dialog.getByRole('button', { name: /offboarding\.submit/ });

    await user.type(dialog.getByLabelText(/offboarding\.reasonLabel/), 'left the company');

    // An empty confirmation field against an empty surname is what used to unlock this button.
    expect(submit).toBeDisabled();

    await user.type(dialog.getByLabelText(/offboarding\.confirmLabel/), EMAIL);

    // And the value the record does carry unlocks it — the one the surname could never have been.
    expect(submit).toBeEnabled();
  });

  /**
   * The defect this whole change exists for, as a test.
   *
   * The confirmation used to compare against `lastName`, and a personnel record nobody has filled
   * in carries `lastName: ''` — the repository answers with an empty row when there is no
   * `EmployeeProfile`, and neither registration nor accepting an invitation creates one. An empty
   * expected value made the comparison true for an **empty** field: the red button unlocked before
   * anything was typed, on the majority of records, and the only barrier against a mis-click on the
   * list disappeared.
   *
   * So the property is stated as fail-closed rather than as «compare with the email»: whatever the
   * value is, if there is nothing to type back the button never unlocks. The case above is the
   * concrete half — the unfilled record, confirming on the address it does carry; this one is the
   * general one, and it empties the address precisely because the rule must not depend on which
   * field the confirmation happens to use.
   */
  it('never unlocks when there is nothing to type back', async () => {
    const user = userEvent.setup();

    await startAt({ profile: () => json({ ...PROFILE, email: '' }) });

    const dialog = within(await openDialog(user));
    const submit = dialog.getByRole('button', { name: /offboarding\.submit/ });

    await user.type(dialog.getByLabelText(/offboarding\.reasonLabel/), 'left the company');

    // An empty field against an empty expectation: equal, and the reason the defect existed.
    expect(submit).toBeDisabled();

    await user.type(dialog.getByLabelText(/offboarding\.confirmLabel/), '   ');
    expect(submit).toBeDisabled();

    await user.type(dialog.getByLabelText(/offboarding\.confirmLabel/), 'anything');
    expect(submit).toBeDisabled();
  });

  it('sends the reason and then shows what was actually revoked', async () => {
    const user = userEvent.setup();

    await startAt();

    await submitOffboarding(user, await openDialog(user));

    await waitFor(() => {
      expect(sent.some((call) => call.url.endsWith('/deactivate'))).toBe(true);
    });
    expect(sent.find((call) => call.url.endsWith('/deactivate'))?.body).toEqual({
      reason: 'left the company',
    });

    // The dialog stays open on success: the report is the answer, and the steps this installation
    // could not take are the half a reader would otherwise assume were done.
    expect(await screen.findByText(/offboarding\.pending\.title/)).toBeInTheDocument();
    expect(screen.getByText(/offboarding\.pending\.vaultMembershipsFlagged/)).toBeInTheDocument();
    expect(screen.getByText(/offboarding\.done\.sessions/)).toBeInTheDocument();
  });

  /**
   * The second run, which the use-case itself calls ordinary — «often run twice, by two people».
   *
   * The server answers `alreadyDeactivated: true` with both counters at zero, and a report that
   * rendered those counters would say «Отозвано сессий: 0 / Покинуто команд: 0» — indistinguishable
   * from a real run that found nothing, which is the reassurance this operation exists to replace.
   */
  it('says that a repeat run changed nothing, instead of counting zeroes', async () => {
    const user = userEvent.setup();

    await startAt({
      deactivate: () =>
        json({ ...REPORT, alreadyDeactivated: true, sessionsRevoked: 0, teamsLeft: 0 }),
    });

    await submitOffboarding(user, await openDialog(user));

    expect(await screen.findByText(/offboarding\.already\.title/)).toBeInTheDocument();
    expect(screen.getByText(/offboarding\.already\.description/)).toBeInTheDocument();
    // The zeroes are not shown at all: «0 sessions revoked» is a sentence about this run that reads
    // as a sentence about the offboarding.
    expect(screen.queryByText(/offboarding\.done\.sessions/)).toBeNull();
    expect(screen.queryByText(/offboarding\.done\.teams/)).toBeNull();
  });

  /**
   * A refusal — 409 `last_owner_required` is the one this endpoint really produces — has to be
   * visible from inside the dialog.
   *
   * The global `MutationCache` toast is not enough here and the reason is mechanical: the dialog is
   * `aria-modal="true"`, so for a screen reader nothing outside it exists while it is open. The
   * failure is therefore rendered where the button was pressed, and the mutation declares its own
   * `onError` so that the toast stands aside rather than adding a second signal
   * (`rules/errors-and-toasts.mdc` §2–§3, `rules/tanstack-query.mdc` §10).
   */
  it('shows a refusal inside the dialog, exactly once', async () => {
    const user = userEvent.setup();

    await startAt({ deactivate: () => problem('last_owner_required', 409) });

    const dialog = await openDialog(user);

    await submitOffboarding(user, dialog);

    expect(await within(dialog).findByText(/offboarding\.failed\.title/)).toBeInTheDocument();
    // One logical action, one signal: the sentence appears in the dialog and nowhere else.
    expect(screen.getAllByText(/errors\.code\.last_owner_required/)).toHaveLength(1);

    // And the form is still there, filled in: a refusal is not a reason to make somebody retype the
    // confirmation of a destructive action.
    expect(within(dialog).getByLabelText(/offboarding\.confirmLabel/)).toHaveValue(EMAIL);
  });

  it('forgets what was typed when the dialog is closed and reopened', async () => {
    // A confirmation that survives a close is a confirmation somebody can finish by accident: reopen
    // the dialog on a different person and the button is already armed.
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openDialog(user));

    await user.type(dialog.getByLabelText(/offboarding\.confirmLabel/), EMAIL);
    await user.click(dialog.getByRole('button', { name: /offboarding\.close/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    const reopened = within(await openDialog(user));

    expect(reopened.getByLabelText(/offboarding\.confirmLabel/)).toHaveValue('');
    expect(reopened.getByRole('button', { name: /offboarding\.submit/ })).toBeDisabled();
  });

  it('closes from the report, and the next open starts from the form again', async () => {
    const user = userEvent.setup();

    await startAt();

    await submitOffboarding(user, await openDialog(user));

    await screen.findByText(/offboarding\.pending\.title/);

    // Two controls read «close» here — the header cross and the button under the report, which share
    // a label on purpose. The last one is the button under the report, and it is the one exercised.
    const closers = within(screen.getByRole('dialog')).getAllByRole('button', {
      name: /offboarding\.close/,
    });

    await user.click(closers[closers.length - 1] as HTMLElement);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // Back to the form: a report left on screen would be a stale answer about a previous run.
    expect(
      within(await openDialog(user)).getByLabelText(/offboarding\.reasonLabel/),
    ).toBeInTheDocument();
  });

  it('traps focus inside the dialog', async () => {
    // The open compliance item from EPIC-007. Tabbing out of a modal that ends somebody's access is
    // how a confirmation gets confirmed by a keystroke meant for the page behind it.
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);

    for (let step = 0; step < 12; step += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  /**
   * The other half of the trap (`rules/a11y.mdc` §6): closing gives the focus back to the control
   * that opened the dialog. Without it a keyboard user lands at the top of the document and tabs
   * back through the whole shell to reach the row they were working on.
   */
  it('returns focus to the trigger when it closes', async () => {
    const user = userEvent.setup();

    await startAt();

    const trigger = await screen.findByRole('button', { name: /offboarding\.action/ });

    await user.click(trigger);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: /offboarding\.close/,
      }),
    );

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });
});

/**
 * axe over **both** faces of the dialog.
 *
 * The report is not a variation on the form: it is an `Alert` and a `List` where the form's inputs
 * were, and scanning only the state a case happens to leave behind is how the half nobody looks at
 * ships with a violation.
 */
describe.each([
  ['while the form is on screen', false],
  ['while the report is on screen', true],
] as const)('the offboarding dialog has no accessibility violation %s', (_case, submitFirst) => {
  it('passes axe', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);

    if (submitFirst) {
      await submitOffboarding(user, dialog);
      await within(dialog).findByText(/offboarding\.pending\.title/);
    }

    const { violations, passes } = await axe.run(dialog, {
      rules: {
        // Disabled because jsdom cannot answer it, not because the answer is inconvenient — and the
        // reason is checked below rather than claimed here. jsdom performs no layout, so every node
        // this rule looks at is judged `hidden` and no pair of colours is ever compared; the
        // stylesheet that defines `--bc-*` is never applied either, so the values it would read are
        // user-agent defaults. Left enabled, the rule would report a permanent green that means
        // «nothing was measured» — the kind of pass that makes a gate stop being believed. Contrast
        // is checked where it can be: `test/theme/tokens.test.ts` computes every token pair in both
        // schemes, and `@axe-core/playwright` runs the rule against a real engine in e2e.
        'color-contrast': { enabled: false },
        // Disabled with a reason, and the reason is checked rather than asserted: the rule is a
        // **document-level** heuristic — «two banner landmarks on one page» — and it does not model
        // `aria-modal`. While this dialog is open the shell behind it is inert for assistive
        // technology, so its header is not a second banner in any sense a reader experiences. The
        // assertion below is what keeps that from being an excuse.
        'landmark-no-duplicate-banner': { enabled: false },
      },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
    // CONTROL: the scan looked at this subtree rather than at nothing. `button-name` is in the list
    // because it once failed here — the modal's close cross had no label.
    expect(passes.map((rule) => rule.id)).toContain('button-name');
    // The premise of the `landmark-no-duplicate-banner` exemption.
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    // The premise of the `color-contrast` exemption, in two halves. First: the colours are not
    // there. The dialog's surface is `--bc-surface` in the product and transparent here, because
    // the stylesheet that defines the token is never applied in jsdom — so anything the rule read
    // would be a user-agent default rather than a design token.
    expect(globalThis.getComputedStyle(dialog).backgroundColor).toBe('rgba(0, 0, 0, 0)');

    // Second: switched on, the rule measures nothing. Every outcome it reports is `hidden` — axe's
    // word for «this node has no box», which without layout is every node. A green from a rule that
    // compared no colours is not evidence of contrast, which is why it is off rather than on.
    const withContrast = await axe.run(dialog, { runOnly: ['color-contrast'] });
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
});

/**
 * The one property `cimode` cannot state.
 *
 * Every assertion above matches a **key**, which is what makes them readable and what makes them
 * blind: `offboarding.confirmHint` matches whether the sentence names the address, names a surname
 * that is no longer passed, or renders `{{lastName}}` because the interpolation variable was
 * renamed in the code and not in the catalogue. Both catalogues are therefore rendered for real,
 * and what is asserted is the thing an administrator has to be able to read: which address to type.
 */
describe.each(['en', 'ru'] as const)('the confirmation hint in %s', (language) => {
  it('names the address that has to be typed back', async () => {
    const user = userEvent.setup();
    const i18n = SharedI18n.createI18n(language);

    await startAt({ i18n, language });

    // Named through the catalogue, not through a key: in a real language the control reads
    // «Deactivate» / «Деактивировать», and a regex over the key would find nothing here.
    await user.click(await screen.findByRole('button', { name: i18n.t('offboarding.action') }));

    const dialog = within(await screen.findByRole('dialog'));

    expect(dialog.getByText(new RegExp(EMAIL))).toBeInTheDocument();
    // Nothing left un-interpolated: a placeholder on screen is a key that was renamed on one side.
    expect(dialog.queryByText(/\{\{/)).toBeNull();
  });
});
