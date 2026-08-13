import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type i18n as I18n } from 'i18next';

import { SharedI18n } from '@shared';

import {
  expectFocusInside,
  expectFocusReturnedTo,
  tabWrapFailures,
  focusEscapes,
  tabbablesOf,
} from '../support/focus-trap.util.js';

/**
 * The administrator's reset of somebody else's second factor, from the personnel card —
 * STORY-013-04, acceptance 10, the half that was left open when the server shipped.
 *
 * The properties, and the first of them is the reason the rest are strict:
 *
 *   * **nothing else stands in the way.** `POST /users/{userId}/reset-mfa` asks the caller for
 *     neither a password nor a code — `user:reset_mfa` *is* the proof — so unlike every other
 *     destructive path in this product (offboarding types an address, the self-service disable
 *     re-proves both factors) this dialog is the only barrier between a click and a colleague's
 *     account dropping to a password alone. That is why the address has to be typed back here too,
 *     and why the confirmation is fail-closed: nothing to type means the button never unlocks;
 *   * **the control is not offered without the record it needs**, and not offered at all without
 *     the permission — a hint, never a gate (`rules/permissions.mdc` §11);
 *   * **the dialog says what it costs before the button**, including the two things nobody can find
 *     out afterwards: every recovery code is destroyed, and every session closes;
 *   * **a run that changed nothing says so** instead of printing zeroes. The server treats a repeat
 *     on an account with no 2FA as a genuine no-op — no session revoked, no version bumped, no mail
 *     — and «Отозвано сессий: 0» would read as a report about the reset rather than about this run,
 *     the same false reassurance `OffboardingReport` exists to prevent;
 *   * **a refusal is visible where the operation was started.** The dialog is `aria-modal`, so a
 *     toast outside it is not in the accessibility tree a screen reader is confined to;
 *   * **the modal traps focus and gives it back** — the four sentences of `rules/a11y.mdc` §6,
 *     asserted through the shared harness rather than restated here.
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

/** `ResetMfaResult`, as `docs/api/openapi.yaml` declares it. */
const RESULT = {
  userId: USER,
  wasEnabled: true,
  recoveryCodesDeleted: 7,
  sessionsRevoked: 3,
};

interface Answers {
  /** What `/me/permissions` grants. The default is the caller this file is mostly about. */
  readonly granted?: readonly string[];
  /** What `GET /employees/{id}` answers, evaluated per request so a retry can answer differently. */
  readonly profile?: () => Response | Promise<Response>;
  readonly reset?: () => Response;
  /** A real catalogue instead of the suite's `cimode` one — see «in a real language» below. */
  readonly i18n?: I18n;
  readonly language?: string;
}

const startAt = async ({
  granted = ['employee:read', 'user:reset_mfa'],
  profile = () => json(PROFILE),
  reset = () => json(RESULT),
  i18n,
  language,
}: Answers = {}): Promise<void> => {
  vi.resetModules();
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
    if (url.endsWith('/reset-mfa')) return reset();
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
  await user.click(await screen.findByRole('button', { name: /security\.reset\.trigger/ }));

  return await screen.findByRole('dialog');
};

/** Types the confirmation and presses the red button. `confirm` is what gets typed back. */
const submitReset = async (
  user: UserEvent,
  dialog: HTMLElement,
  confirm: string = EMAIL,
): Promise<void> => {
  const scope = within(dialog);

  await user.type(scope.getByLabelText(/security\.reset\.confirmLabel/), confirm);
  await user.click(scope.getByRole('button', { name: /security\.reset\.submit/ }));
};

const resetCalls = (): Call[] => sent.filter((call) => call.url.endsWith('/reset-mfa'));

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('the administrative 2FA reset', () => {
  it('is not offered at all to somebody without the permission', async () => {
    // `user:read` is granted for the reason the two cases below grant it: the sidebar entry it gates
    // is the only thing on screen that proves `/me/permissions` has **answered**. Without it this
    // case is equally green while the query is still in flight — `can('user:reset_mfa')` is `false`
    // then too — and would assert nothing about the refusal it is named after.
    await startAt({ granted: ['employee:read', 'user:read'] });

    // Both preconditions of the absence, so that neither can be what produced it: the permissions
    // have arrived, and so has the record the control would confirm against.
    await screen.findByText(/nav\.adminMembers/);
    await screen.findByLabelText(/employee\.firstName/);

    expect(screen.queryByRole('button', { name: /security\.reset\.trigger/ })).toBeNull();
    // The heading too: a «Two-factor authentication» section with nothing under it announces an
    // action to somebody who cannot take it, which is the opposite of what hiding the button is for.
    expect(screen.queryByRole('heading', { name: /security\.reset\.title/ })).toBeNull();
  });

  /**
   * The trigger and the dialog are one decision, not two — the same reasoning the offboarding
   * control on this screen is built on. A button drawn from `can(...)` alone is clickable while the
   * document is still on its way, and the confirmation cannot ask anybody to type back an address
   * the page has not got.
   */
  it('is not offered until the record it confirms against has arrived', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await startAt({
      granted: ['employee:read', 'user:reset_mfa', 'user:read'],
      // A fresh `Response` per call, held behind one gate: `StrictMode` mounts twice, and a single
      // `Response` handed to both consumers is a body that can only be read once.
      profile: async () => {
        await gate;

        return json(PROFILE);
      },
    });

    await screen.findByText(/nav\.adminMembers/);
    await screen.findByTestId('text-skeleton');
    expect(screen.queryByRole('button', { name: /security\.reset\.trigger/ })).toBeNull();

    release();

    // CONTROL: the same mount, the same permission — only the document changed.
    expect(
      await screen.findByRole('button', { name: /security\.reset\.trigger/ }),
    ).toBeInTheDocument();
  });

  /**
   * And for ever, when the document never arrives. The screen says «this did not load» once,
   * through `DataState`; a red button left below it would be a second, contradictory answer to the
   * same condition (`rules/errors-and-toasts.mdc` §2) — and one that leads nowhere.
   */
  it('is not offered when the record cannot be loaded', async () => {
    // A flag rather than a request counter: the query retries once by default and `StrictMode`
    // mounts twice, so «fail the first attempt» would have been repaired by the suite itself.
    let recovers = false;

    await startAt({
      granted: ['employee:read', 'user:reset_mfa', 'user:read'],
      profile: () => (recovers ? json(PROFILE) : problem('user_forbidden', 403)),
    });

    await screen.findByText(/nav\.adminMembers/);
    await screen.findByTestId('error-state');
    expect(screen.queryByRole('button', { name: /security\.reset\.trigger/ })).toBeNull();

    // CONTROL: retry succeeds and the control appears — the permission was granted all along.
    recovers = true;
    await userEvent.setup().click(screen.getByRole('button', { name: 'common.retry' }));

    expect(
      await screen.findByRole('button', { name: /security\.reset\.trigger/ }),
    ).toBeInTheDocument();
  });

  /**
   * Every consequence, before the button rather than after it.
   *
   * Two of the five cannot be found out afterwards — the codes are destroyed and the sessions are
   * gone — and one of the remaining three is what separates this red button from the other red
   * button on the same card: the account keeps working. An administrator who confuses the two ends
   * somebody's employment when they meant to help them sign in.
   */
  it('lists what the reset costs before the button that does it', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openDialog(user));

    expect(dialog.getByText(/security\.reset\.consequence\.passwordOnly/)).toBeInTheDocument();
    expect(dialog.getByText(/security\.reset\.consequence\.codes/)).toBeInTheDocument();
    expect(dialog.getByText(/security\.reset\.consequence\.sessions/)).toBeInTheDocument();
    expect(dialog.getByText(/security\.reset\.consequence\.notified/)).toBeInTheDocument();
    expect(dialog.getByText(/security\.reset\.consequence\.accessKept/)).toBeInTheDocument();
  });

  it('keeps the button unusable until the address is typed back', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openDialog(user));
    const submit = dialog.getByRole('button', { name: /security\.reset\.submit/ });

    expect(submit).toBeDisabled();

    // The wrong person is exactly the mis-click this control exists for: the card is reached from a
    // row in a directory, and nothing on the server will notice.
    await user.type(dialog.getByLabelText(/security\.reset\.confirmLabel/), 'sidorov@example.test');
    expect(submit).toBeDisabled();

    await user.clear(dialog.getByLabelText(/security\.reset\.confirmLabel/));
    await user.type(dialog.getByLabelText(/security\.reset\.confirmLabel/), ' IVAN@example.test ');

    // Trimmed and case-insensitive: the control is «did you mean this person», not a typing test.
    expect(submit).toBeEnabled();
  });

  /**
   * Fail-closed, stated over the record that makes it matter.
   *
   * The offboarding confirmation on this same screen used to compare against `lastName`, which is
   * empty on every personnel record nobody has filled in — so the red button was armed before
   * anything was typed. The rule that came out of it is not «compare with the email» but «nothing
   * to type back means it never unlocks», and it is restated here rather than inherited: this is a
   * second confirmation, written later, and the defect it protects against is a property of the
   * comparison rather than of the field.
   */
  it('never unlocks when there is nothing to type back', async () => {
    const user = userEvent.setup();

    await startAt({ profile: () => json({ ...PROFILE, email: '' }) });

    const dialog = within(await openDialog(user));
    const submit = dialog.getByRole('button', { name: /security\.reset\.submit/ });

    // An empty field against an empty expectation: equal, and the shape the defect took last time.
    expect(submit).toBeDisabled();

    await user.type(dialog.getByLabelText(/security\.reset\.confirmLabel/), '   ');
    expect(submit).toBeDisabled();

    await user.type(dialog.getByLabelText(/security\.reset\.confirmLabel/), 'anything');
    expect(submit).toBeDisabled();
  });

  /**
   * The request itself, and the header the contract makes mandatory.
   *
   * `components.parameters.IdempotencyKey` is `required: true` on this operation, so a call without
   * it is a 422 nobody would find by clicking — the generated types demand it at the call site, and
   * this is the assertion that the call site actually satisfies them rather than casting past them.
   */
  it('posts the reset with an idempotency key and no body, then reports what it revoked', async () => {
    const user = userEvent.setup();

    await startAt();

    await submitReset(user, await openDialog(user));

    await waitFor(() => {
      expect(resetCalls()).toHaveLength(1);
    });

    const [call] = resetCalls();

    expect(call?.url).toBe(`/api/v1/users/${USER}/reset-mfa`);
    expect(call?.method).toBe('POST');
    expect(call?.headers['idempotency-key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The operation declares no request body; sending one would be inventing a contract.
    expect(call?.body).toBe('');

    // The dialog stays open on success and shows the counts: a reset whose answer carries no
    // numbers is one the administrator has to trust rather than check.
    expect(await screen.findByText(/security\.reset\.done\.title/)).toBeInTheDocument();
    expect(screen.getByText(/security\.reset\.done\.codes/)).toBeInTheDocument();
    expect(screen.getByText(/security\.reset\.done\.sessions/)).toBeInTheDocument();
    // What the administrator has to do next — nobody's 2FA was set up by this, only removed.
    expect(screen.getByText(/security\.reset\.done\.next/)).toBeInTheDocument();
  });

  /**
   * The run that changed nothing, which is a state this operation reaches often: the client cannot
   * know whether a colleague has a second factor at all — no document in the contract carries it —
   * so «reset somebody who never had it» is ordinary rather than exceptional.
   *
   * The server answers `wasEnabled: false` and does nothing at all: no session revoked, no recovery
   * code batch to delete, no permission version bumped, no mail sent. Rendering the counters would
   * print «Recovery codes deleted: 0 / Sessions revoked: 0» — indistinguishable from a real reset
   * that found nothing, which is precisely the reassurance this report exists not to give.
   */
  it('says that a reset which changed nothing changed nothing, instead of counting zeroes', async () => {
    const user = userEvent.setup();

    await startAt({
      reset: () =>
        json({ ...RESULT, wasEnabled: false, recoveryCodesDeleted: 0, sessionsRevoked: 0 }),
    });

    await submitReset(user, await openDialog(user));

    expect(await screen.findByText(/security\.reset\.already\.title/)).toBeInTheDocument();
    expect(screen.getByText(/security\.reset\.already\.description/)).toBeInTheDocument();
    expect(screen.queryByText(/security\.reset\.done\.codes/)).toBeNull();
    expect(screen.queryByText(/security\.reset\.done\.sessions/)).toBeNull();
  });

  /**
   * A refusal has to be visible from inside the dialog, and the reason is mechanical: the dialog is
   * `aria-modal="true"`, so for a screen reader nothing outside it exists while it is open. The
   * mutation declares its own `onError` so the global toast stands aside rather than adding a
   * second signal (`rules/errors-and-toasts.mdc` §2–§3, `rules/tanstack-query.mdc` §10).
   *
   * `409 self_lockout` is the refusal this endpoint really produces for the case the interface does
   * not prevent: an administrator on their own personnel card. The way out of their own second
   * factor is the self-service one, which re-proves both factors — resetting it from here would
   * make `user:reset_mfa` a way around the very thing it exists to restore.
   */
  it('shows a refusal inside the dialog, exactly once', async () => {
    const user = userEvent.setup();

    await startAt({ reset: () => problem('self_lockout', 409) });

    const dialog = await openDialog(user);

    await submitReset(user, dialog);

    expect(await within(dialog).findByText(/security\.reset\.failed\.title/)).toBeInTheDocument();
    // One logical action, one signal: the sentence appears in the dialog and nowhere else.
    expect(screen.getAllByText(/errors\.code\.self_lockout/)).toHaveLength(1);

    // And what was typed survives: a refusal is not a reason to make somebody retype the
    // confirmation of a destructive action.
    expect(within(dialog).getByLabelText(/security\.reset\.confirmLabel/)).toHaveValue(EMAIL);
  });

  it('forgets what was typed when the dialog is closed and reopened', async () => {
    // A confirmation that survives a close is a confirmation somebody can finish by accident:
    // reopen on a different person and the button is already armed.
    const user = userEvent.setup();

    await startAt();

    const dialog = within(await openDialog(user));

    await user.type(dialog.getByLabelText(/security\.reset\.confirmLabel/), EMAIL);
    await user.click(dialog.getByRole('button', { name: /security\.reset\.cancel/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    const reopened = within(await openDialog(user));

    expect(reopened.getByLabelText(/security\.reset\.confirmLabel/)).toHaveValue('');
    expect(reopened.getByRole('button', { name: /security\.reset\.submit/ })).toBeDisabled();
  });

  it('closes from the report, and the next open starts from the form again', async () => {
    const user = userEvent.setup();

    await startAt();

    await submitReset(user, await openDialog(user));

    await screen.findByText(/security\.reset\.done\.title/);

    // Two controls read «close» on this face — the header cross and the button under the report,
    // which share a label on purpose. The last one is the button under the report.
    const closers = within(screen.getByRole('dialog')).getAllByRole('button', {
      name: /security\.reset\.close/,
    });

    await user.click(closers[closers.length - 1] as HTMLElement);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // Back to the form: a report left on screen would be a stale answer about a previous run — and
    // a second reset would be one click away from a dialog that says the last one succeeded.
    expect(
      within(await openDialog(user)).getByLabelText(/security\.reset\.confirmLabel/),
    ).toBeInTheDocument();
  });

  it('moves the focus into itself, and not onto the button that resets', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);

    await waitFor(() => {
      // The header cross: the first tabbable node in the dialog, and the safe one.
      expect(expectFocusInside(dialog)).toHaveAccessibleName(/security\.reset\.close/);
    });
    // The red button is `disabled` until the address is typed, so it is not merely «not first» — it
    // is not reachable by keyboard at all yet.
    expect(
      tabbablesOf(dialog).includes(
        within(dialog).getByRole('button', { name: /security\.reset\.submit/ }),
      ),
    ).toBe(false);
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
   * `Esc` abandons the confirmation, and abandoning is the whole of what it does.
   *
   * The absence of the request is the assertion rather than decoration: once the dialog is gone,
   * «Escape closed it» and «Escape submitted it» look identical from outside, and the second would
   * strip a colleague's second factor from a keystroke aimed at the page behind.
   */
  it('abandons on Escape without resetting anybody, and gives the focus back', async () => {
    const user = userEvent.setup();

    await startAt();

    const trigger = await screen.findByRole('button', { name: /security\.reset\.trigger/ });

    await user.click(trigger);

    const dialog = await screen.findByRole('dialog');

    // Typed in first, so the case is about `Esc` on an **armed** dialog rather than on one whose
    // button was disabled anyway — the only state in which a stray submission is possible at all.
    await user.type(within(dialog).getByLabelText(/security\.reset\.confirmLabel/), EMAIL);
    expect(within(dialog).getByRole('button', { name: /security\.reset\.submit/ })).toBeEnabled();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expectFocusReturnedTo(trigger, 'the control that opens the reset dialog');
    });
    expect(resetCalls()).toEqual([]);
  });

  /**
   * The other half of the trap (`rules/a11y.mdc` §6): closing gives the focus back to the control
   * that opened the dialog. Without it a keyboard user lands at the top of the document and tabs
   * back through the whole shell to reach the record they were working on.
   */
  it('returns focus to the trigger when it closes', async () => {
    const user = userEvent.setup();

    await startAt();

    const trigger = await screen.findByRole('button', { name: /security\.reset\.trigger/ });

    await user.click(trigger);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: /security\.reset\.close/,
      }),
    );

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expectFocusReturnedTo(trigger, 'the control that opens the reset dialog');
    });
  });
});

/**
 * axe over **both** faces of the dialog.
 *
 * The report is not a variation on the form: it is an `Alert` and a `List` where the confirmation
 * field was, and scanning only the state a case happens to leave behind is how the half nobody
 * looks at ships with a violation.
 */
describe.each([
  ['while the confirmation is on screen', false],
  ['while the report is on screen', true],
] as const)('the reset dialog has no accessibility violation %s', (_case, submitFirst) => {
  it('passes axe', async () => {
    const user = userEvent.setup();

    await startAt();

    const dialog = await openDialog(user);

    if (submitFirst) {
      await submitReset(user, dialog);
      await within(dialog).findByText(/security\.reset\.done\.title/);
    }

    const { violations, passes } = await axe.run(dialog, {
      rules: {
        // Disabled because jsdom cannot answer it, not because the answer is inconvenient — and the
        // reason is checked below rather than claimed here. jsdom performs no layout, so every node
        // this rule looks at is judged `hidden` and no pair of colours is ever compared. Contrast is
        // checked where it can be: `test/theme/tokens.test.ts` computes every token pair in both
        // schemes, and `@axe-core/playwright` runs the rule against a real engine in e2e.
        'color-contrast': { enabled: false },
        // Disabled with a reason, and the reason is checked rather than asserted: the rule is a
        // **document-level** heuristic — «two banner landmarks on one page» — and it does not model
        // `aria-modal`. While this dialog is open the shell behind it is inert for assistive
        // technology, so its header is not a second banner in any sense a reader experiences.
        'landmark-no-duplicate-banner': { enabled: false },
      },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
    // CONTROL: the scan looked at this subtree rather than at nothing. `button-name` is in the list
    // because it is the rule a Mantine close cross fails without an explicit label.
    expect(passes.map((rule) => rule.id)).toContain('button-name');
    // The premise of the `landmark-no-duplicate-banner` exemption.
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    // The premise of the `color-contrast` exemption, in two halves. First: the colours are not
    // there — the stylesheet that defines `--bc-*` is never applied in jsdom.
    expect(globalThis.getComputedStyle(dialog).backgroundColor).toBe('rgba(0, 0, 0, 0)');

    // Second: switched on, the rule measures nothing. Every outcome it reports is `hidden` — axe's
    // word for «this node has no box», which without layout is every node.
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
 * The properties `cimode` cannot state.
 *
 * Every assertion above matches a **key**, which is what makes them readable and what makes them
 * blind: under `cimode` `t(key)` returns the key, so a control whose label was never passed through
 * `t()` at all is indistinguishable from one that was, and `security.reset.confirmHint` matches
 * whether the sentence names the address or renders `{{email}}` because the interpolation variable
 * was renamed on one side only.
 *
 * So both catalogues are rendered for real, and what is asserted is what an administrator has to be
 * able to read: which address to type, and that the two irreversible consequences are spelled out.
 */
describe.each(['en', 'ru'] as const)('the reset dialog in %s', (language) => {
  it('names the address to type back and spells out what is destroyed', async () => {
    const user = userEvent.setup();
    const i18n = SharedI18n.createI18n(language);

    await startAt({ i18n, language });

    // Named through the catalogue, not through a key: in a real language the control reads «Reset
    // two-factor authentication» / «Сбросить двухфакторную аутентификацию», and a regex over the
    // key would find nothing here.
    await user.click(await screen.findByRole('button', { name: i18n.t('security.reset.trigger') }));

    const dialog = within(await screen.findByRole('dialog'));

    // Twice, and both matter: the description says **whose** account this is about, and the hint
    // under the field says what to type. Either one alone leaves the other interpolation free to
    // render `{{email}}` unnoticed.
    expect(dialog.getAllByText(new RegExp(EMAIL))).toHaveLength(2);
    // The two consequences nobody can find out afterwards, as the sentences the catalogue carries —
    // so a key that exists but was never rendered fails here rather than passing on its own name.
    expect(dialog.getByText(i18n.t('security.reset.consequence.codes'))).toBeInTheDocument();
    expect(dialog.getByText(i18n.t('security.reset.consequence.sessions'))).toBeInTheDocument();
    // Nothing left un-interpolated: a placeholder on screen is a variable renamed on one side.
    expect(dialog.queryByText(/\{\{/)).toBeNull();
    // And no raw key reached the screen: `t()` returns the key itself when the catalogue has no
    // entry, which is the one failure a `cimode` suite can never see.
    expect(dialog.queryByText(/security\.reset\./)).toBeNull();
  });
});
