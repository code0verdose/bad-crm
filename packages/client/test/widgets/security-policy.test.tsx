import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { assert, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { axeViolationsIn } from '../support/axe-scan.util.js';
import {
  expectFocusInside,
  expectFocusReturnedTo,
  focusEscapes,
  tabWrapFailures,
} from '../support/focus-trap.util.js';

/**
 * The organization's second-factor policy on `/admin/organization?tab=security` — STORY-013-05,
 * the screen half the server shipped the contract for.
 *
 * The properties, and the first is the one the whole story turns on:
 *
 *   * **the confirmation asks the server about the draft.** The screen already holds a coverage
 *     report — of the policy *in force* — and the cheap thing to do is caption it with the draft.
 *     Then the dialog names the people yesterday's policy covers while the button applies today's.
 *     The stub below answers the two questions **differently on purpose**, so a preview computed
 *     from the rows already on screen fails here rather than in an organization;
 *   * **the 428 is not a failure.** `confirmation_required` is the server asking whether somebody
 *     means to put themselves under a requirement they do not meet (acceptance 7): the dialog shows
 *     a warning, the button changes its words, and the repeat carries `confirmedSelfLockout`.
 *     Nothing red, and no toast — the dialog is `aria-modal`, so a toast outside it is not in the
 *     tree a screen-reader user is confined to;
 *   * **the coverage filters are the URL** (`rules/lists-and-filters.mdc`): a link opened with a
 *     filter in it arrives filtered, and typing writes the address rather than a component's state;
 *   * **the tab is behind its capability** (acceptance 8), and the refusal names it;
 *   * **the modal traps focus and gives it back** — the four sentences of `rules/a11y.mdc` §6,
 *     through the shared harness rather than restated here. The trigger is deliberately never
 *     disabled, which is what makes the return land on something.
 */

const POLICY = {
  mfaRequiredForRoles: ['admin'],
  mfaGracePeriodDays: 3,
  mfaRequiredSince: { admin: '2026-09-01T00:00:00.000Z' },
};

/** The standing report: only `admin` is covered, and only Ada holds it. */
const STANDING_REPORT = {
  policy: POLICY,
  covered: 1,
  enrolled: 0,
  rows: [
    {
      userId: '018f4a3b-2c1d-7a41-9f00-000000000001',
      email: 'ada@example.test',
      roleKeys: ['admin'],
      gate: 'grace',
      graceEndsAt: '2026-09-20T00:00:00.000Z',
    },
    {
      userId: '018f4a3b-2c1d-7a41-9f00-000000000002',
      email: 'boris@example.test',
      roleKeys: ['manager'],
      gate: 'not_covered',
    },
    {
      userId: '018f4a3b-2c1d-7a41-9f00-000000000003',
      email: 'clara@example.test',
      roleKeys: ['developer'],
      gate: 'not_covered',
    },
  ],
};

/**
 * The preview of «admin **and** manager»: a different answer, naming somebody the standing report
 * calls «not covered».
 *
 * Boris is the whole point of this fixture. A dialog that filtered the rows it already had would
 * never show him, because in those rows he is `not_covered` — so the case that expects his address
 * inside the dialog fails for exactly the defect the endpoint exists to prevent.
 */
const DRAFT_REPORT = {
  policy: { ...POLICY, mfaRequiredForRoles: ['admin', 'manager'], mfaGracePeriodDays: 7 },
  covered: 2,
  enrolled: 0,
  rows: [
    { ...STANDING_REPORT.rows[0], gate: 'grace' },
    { ...STANDING_REPORT.rows[1], gate: 'enrollment_required' },
    STANDING_REPORT.rows[2],
  ],
};

interface Call {
  readonly url: string;
  /** The whole query string, because what this screen is judged on is the parameters it sends. */
  readonly search: string;
  readonly method: string;
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

interface Answers {
  readonly granted?: readonly string[];
  readonly path?: string;
  readonly policy?: () => Response;
  readonly coverage?: (search: URLSearchParams) => Response | Promise<Response>;
  readonly update?: (body: string) => Response | Promise<Response>;
}

type Rendered = Awaited<ReturnType<typeof mountApp>>;

const mountApp = async (path: string, options: { readonly language?: string } = {}) => {
  const { renderApp } = await import('../support/render-app.util.js');

  return renderApp({
    path,
    status: 'authenticated',
    ...(options.language === undefined ? {} : { language: options.language }),
  });
};

const startAt = async ({
  granted = ['organization:manage_security_policy'],
  path = '/admin/organization?tab=security',
  policy = () => json(POLICY),
  coverage = (search) =>
    // The draft is «any role parameter, or a grace period» — exactly what the server treats as one
    // (`security-policy.validator.ts`). Answering both from one branch would let a screen asking the
    // wrong question pass.
    search.has('role') || search.has('graceDays') ? json(DRAFT_REPORT) : json(STANDING_REPORT),
  update = () => json({ ...POLICY, mfaRequiredForRoles: ['admin', 'manager'] }),
}: Answers = {}): Promise<Rendered> => {
  vi.resetModules();
  vi.stubGlobal('fetch', async (input: Request) => {
    const parsed = new URL(input.url);
    const body = await input.clone().text();

    sent.push({ url: parsed.pathname, search: parsed.search, method: input.method, body });

    if (parsed.pathname.endsWith('/me/permissions')) {
      return json({ permissions: [...granted], denied: [], roles: [], isOwner: false, version: 1 });
    }
    if (parsed.pathname.endsWith('/organization/mfa-coverage')) {
      return await coverage(parsed.searchParams);
    }
    if (parsed.pathname.endsWith('/organization/security-policy')) {
      return input.method === 'PATCH' ? update(body) : policy();
    }

    return json({ status: 'ok' });
  });

  return await mountApp(path);
};

const coverageCalls = (): Call[] =>
  sent.filter((call) => call.url.endsWith('/organization/mfa-coverage'));

const updateCalls = (): Call[] =>
  sent.filter(
    (call) => call.url.endsWith('/organization/security-policy') && call.method === 'PATCH',
  );

/** Opens the confirmation and hands back both the trigger and the dialog. */
const openPreview = async (
  user: UserEvent,
): Promise<{ readonly trigger: HTMLElement; readonly dialog: HTMLElement }> => {
  const trigger = await screen.findByRole('button', { name: 'organization.security.review' });

  await user.click(trigger);

  return { trigger, dialog: await screen.findByRole('dialog') };
};

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('the security tab of /admin/organization', () => {
  it('refuses somebody without organization:manage_security_policy, naming the key', async () => {
    await startAt({ granted: ['user:read'] });

    expect(await screen.findByTestId('forbidden-state')).toHaveTextContent(
      'organization:manage_security_policy',
    );
    // The guard runs in `beforeLoad`, so nothing behind it is asked for at all — a screen that
    // rendered and then filled with 403s would satisfy the sentence above and not the criterion.
    expect(sent.filter((call) => call.url.includes('/organization/'))).toEqual([]);
  });

  /**
   * The menu entry, from the same mount — and it is the wiring rather than the filter that is under
   * test here.
   *
   * `test/widgets/nav-sections.test.ts` proves `visibleSections` over `NAV_SECTIONS` with a predicate
   * of its own choosing, so it stays green whichever predicate the shell actually passes. This case
   * runs the real one: `app-shell.widget.tsx` filters with `useCan().holds`, and with `can` — which
   * demands an ACL level for this key — the entry disappears for the very person who may use it.
   */
  it('offers the section in the navigation to somebody who holds the capability', async () => {
    await startAt();

    expect(await screen.findByRole('link', { name: 'nav.adminOrganization' })).toHaveAttribute(
      'href',
      '/admin/organization',
    );
  });

  it('shows the stored policy as the draft to edit', async () => {
    await startAt();

    expect(
      await screen.findByRole('checkbox', { name: 'organization.security.role.admin' }),
    ).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: 'organization.security.role.owner' }),
    ).not.toBeChecked();
    expect(screen.getByLabelText('organization.security.graceLabel')).toHaveValue('3');
  });

  /**
   * The criterion this whole story turns on (acceptance 2).
   *
   * Two assertions, and both are needed. The parameters prove the *question* was asked about the
   * draft; Boris's address in the dialog proves the *answer* was used — he is `not_covered` in the
   * rows the screen already holds, so a preview assembled from those could not name him.
   */
  it('asks the server about the unsaved draft, and shows that answer', async () => {
    const user = userEvent.setup();

    await startAt();

    await user.click(
      await screen.findByRole('checkbox', { name: 'organization.security.role.manager' }),
    );
    // Four presses rather than typing a digit: Mantine's `NumberInput` is a masked field, and
    // `type()` into it fires no change in jsdom — the arrows are a real keyboard path and do.
    await user.type(
      screen.getByLabelText('organization.security.graceLabel'),
      '{arrowup}{arrowup}{arrowup}{arrowup}',
    );

    const { dialog } = await openPreview(user);

    await waitFor(() => {
      expect(within(dialog).getByText(/boris@example\.test/)).toBeInTheDocument();
    });

    // Everybody the policy covers, and nobody it does not: clara is `not_covered` in the very same
    // answer, so a dialog that listed the whole report rather than the people who owe a second factor
    // would name her too.
    expect(within(dialog).queryByText('clara@example.test')).toBeNull();

    const preview = coverageCalls().at(-1);
    const parameters = new URLSearchParams(preview?.search ?? '');

    expect(parameters.getAll('role')).toEqual(['admin', 'manager']);
    expect(parameters.get('graceDays')).toBe('7');
  });

  /**
   * Switching the policy **off** is the change most worth previewing, and the one an obvious
   * implementation cannot preview at all: `openapi-fetch` drops an empty array, and the server reads
   * «neither parameter present» as «report on the stored policy». Sending `graceDays` regardless is
   * what keeps the answer about the draft.
   */
  it('previews an emptied policy as a draft rather than as the stored one', async () => {
    const user = userEvent.setup();

    await startAt();

    await user.click(
      await screen.findByRole('checkbox', { name: 'organization.security.role.admin' }),
    );

    const { dialog } = await openPreview(user);

    await waitFor(() => {
      expect(coverageCalls().length).toBeGreaterThan(1);
    });

    const preview = coverageCalls().at(-1);
    const parameters = new URLSearchParams(preview?.search ?? '');

    expect(parameters.getAll('role')).toEqual([]);
    expect(parameters.get('graceDays')).toBe('3');
    // The stub answers a draft request with the draft report, so the dialog showing it proves the
    // request was read as one.
    expect(await within(dialog).findByText('boris@example.test')).toBeInTheDocument();
  });

  /**
   * Reopened for a second draft, the dialog must not still be showing the first one's answer.
   *
   * It did. `keepPreviousData` on the preview query kept the previous draft's numbers and names on
   * screen with `status: 'success'`, and the apply button live underneath them — the confirmation
   * naming the wrong people, which is the one failure this whole endpoint exists to prevent.
   */
  it('does not show one draft answer while asking about another', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const second = new Promise<void>((resolve) => {
      release = resolve;
    });

    await startAt({
      coverage: async (search) => {
        if (!search.has('role') && !search.has('graceDays')) return json(STANDING_REPORT);
        if (!search.getAll('role').includes('manager')) {
          return json({ policy: POLICY, covered: 9, enrolled: 9, rows: [] });
        }

        // Held, so the assertion below is made **while** the second draft is in flight — which is
        // the whole window the defect lives in.
        await second;

        return json(DRAFT_REPORT);
      },
    });

    await user.click(
      await screen.findByRole('checkbox', { name: 'organization.security.role.owner' }),
    );

    const first = await openPreview(user);

    await within(first.dialog).findByText('organization.security.preview.empty');

    await user.click(
      within(first.dialog).getByRole('button', { name: 'organization.security.preview.cancel' }),
    );
    await user.click(screen.getByRole('checkbox', { name: 'organization.security.role.manager' }));

    const reopened = await openPreview(user);

    // Nothing from the previous draft is on screen: a skeleton is the honest state while the answer
    // for **this** draft is on its way. With `keepPreviousData` the old sentence stays, under a live
    // apply button — the confirmation describing a policy other than the one it would apply.
    expect(within(reopened.dialog).queryByText('organization.security.preview.empty')).toBeNull();
    expect(within(reopened.dialog).getByTestId('text-skeleton')).toBeInTheDocument();

    release();

    expect(await within(reopened.dialog).findByText('boris@example.test')).toBeInTheDocument();
  });

  it('applies the draft, and only after the confirmation', async () => {
    const user = userEvent.setup();

    await startAt();

    await user.click(
      await screen.findByRole('checkbox', { name: 'organization.security.role.manager' }),
    );
    // Nothing has been written by drafting alone: the policy is saved from inside the dialog.
    expect(updateCalls()).toEqual([]);

    const { dialog } = await openPreview(user);

    await user.click(
      within(dialog).getByRole('button', { name: 'organization.security.preview.apply' }),
    );

    await waitFor(() => {
      expect(updateCalls()).toHaveLength(1);
    });
    expect(JSON.parse(updateCalls()[0]?.body ?? '{}')).toEqual({
      mfaRequiredForRoles: ['admin', 'manager'],
      mfaGracePeriodDays: 3,
    });
    // The dialog closes on the mutation's own success rather than on an effect watching a flag.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  /**
   * Acceptance 7: the refusal that is not one.
   *
   * A red alert here would tell somebody their policy was rejected at the moment they are being
   * asked to confirm it — so the shape of the answer is asserted, not merely its presence.
   */
  it('asks a second time before letting somebody cover themselves, then repeats with the flag', async () => {
    const user = userEvent.setup();
    let confirmed = false;

    await startAt({
      update: (body) => {
        if (
          (JSON.parse(body) as { confirmedSelfLockout?: boolean }).confirmedSelfLockout === true
        ) {
          confirmed = true;

          return json({ ...POLICY, mfaRequiredForRoles: ['admin', 'owner'] });
        }

        return problem('confirmation_required', 428);
      },
    });

    await user.click(
      await screen.findByRole('checkbox', { name: 'organization.security.role.owner' }),
    );

    const { dialog } = await openPreview(user);

    await user.click(
      within(dialog).getByRole('button', { name: 'organization.security.preview.apply' }),
    );

    const warning = await within(dialog).findByRole('alert');

    expect(warning).toHaveTextContent('organization.security.preview.selfLockout.title');
    // Not a failure: the red «the policy was not applied» heading must not be on screen.
    expect(within(dialog).queryByText('organization.security.preview.failed.title')).toBeNull();

    await user.click(
      within(dialog).getByRole('button', {
        name: 'organization.security.preview.selfLockout.confirm',
      }),
    );

    await waitFor(() => {
      expect(confirmed).toBe(true);
    });
    expect(JSON.parse(updateCalls().at(-1)?.body ?? '{}')).toMatchObject({
      confirmedSelfLockout: true,
    });
  });

  it('writes the tab a click asks for, replacing rather than stacking history', async () => {
    const user = userEvent.setup();

    const { router } = await startAt();

    await screen.findByRole('checkbox', { name: 'organization.security.role.admin' });
    await user.click(screen.getByRole('tab', { name: 'organization.tab.security' }));

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ tab: 'security' });
    });
    expect(router.history.length).toBe(1);
  });

  it('reports a policy that cannot be read, with a way back', async () => {
    let recovers = false;

    await startAt({
      policy: () => (recovers ? json(POLICY) : problem('internal_error', 500)),
    });

    await screen.findByTestId('error-state');
    // The section says «this did not load» once and offers nothing else — no half-drawn form under
    // a red message, which would be a second, contradictory answer to the same condition.
    expect(screen.queryByRole('checkbox', { name: 'organization.security.role.admin' })).toBeNull();

    recovers = true;
    await userEvent
      .setup()
      .click(screen.getAllByRole('button', { name: 'common.retry' })[0] as HTMLElement);

    expect(
      await screen.findByRole('checkbox', { name: 'organization.security.role.admin' }),
    ).toBeChecked();
  });

  it('takes a role back out of the draft, and forgets the draft on discard', async () => {
    const user = userEvent.setup();

    await startAt();

    const admin = await screen.findByRole('checkbox', { name: 'organization.security.role.admin' });

    await user.click(admin);

    expect(admin).not.toBeChecked();
    // Emptying the list is «off», never «everybody» — and the screen says so rather than leaving
    // the sentence about how many roles are covered.
    expect(screen.getByText('organization.security.off')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'organization.security.discard' }));

    expect(admin).toBeChecked();
    // The discard affordance is gone with the change it would have undone.
    expect(screen.queryByRole('button', { name: 'organization.security.discard' })).toBeNull();
  });

  /**
   * A swap keeps the **count** and changes the policy, which is the case an `isDirty` written as a
   * length comparison alone gets wrong — and the failure is silent: the apply button stays inert and
   * the change cannot be saved.
   */
  it('counts a swapped role as a change, not only an added one', async () => {
    const user = userEvent.setup();

    await startAt();

    await user.click(
      await screen.findByRole('checkbox', { name: 'organization.security.role.admin' }),
    );
    await user.click(screen.getByRole('checkbox', { name: 'organization.security.role.manager' }));

    const { dialog } = await openPreview(user);
    const apply = within(dialog).getByRole('button', {
      name: 'organization.security.preview.apply',
    });

    expect(apply).toHaveAttribute('aria-disabled', 'false');

    await user.click(apply);

    await waitFor(() => {
      expect(updateCalls()).toHaveLength(1);
    });
    expect(JSON.parse(updateCalls()[0]?.body ?? '{}')).toMatchObject({
      mfaRequiredForRoles: ['manager'],
    });
  });

  it('says how many roles the draft covers, and reads an emptied grace period as zero', async () => {
    const user = userEvent.setup();

    await startAt();

    const grace = await screen.findByLabelText('organization.security.graceLabel');

    await user.clear(grace);

    // Mantine reports an emptied number field as `''`; zero is the honest reading of «no grace
    // period» and is the schema's own minimum, so there is no third state to represent.
    expect(grace).toHaveValue('0');
    expect(screen.getByText('organization.security.on')).toBeInTheDocument();
  });

  /**
   * A policy may name a custom role by id, and this screen has no picker for one. What it must not
   * do is pretend the checkboxes are the whole policy — somebody would then «turn the policy off»
   * by unticking three boxes while a fourth role kept it on.
   */
  it('says when the policy names a role it cannot show', async () => {
    await startAt({
      policy: () =>
        json({
          ...POLICY,
          mfaRequiredForRoles: ['admin', '018f4a3b-2c1d-7a41-9f00-0000000000ff'],
        }),
    });

    expect(await screen.findByText('organization.security.customRoles')).toBeInTheDocument();
  });

  /**
   * The second signal of acceptance 7 belongs to the draft it was asked about.
   *
   * Carried over, it would send `confirmedSelfLockout: true` for a policy the server never examined
   * — a safeguard spent in advance, on a different question.
   */
  it('forgets a refused confirmation as soon as the draft moves', async () => {
    const user = userEvent.setup();

    await startAt({ update: () => problem('confirmation_required', 428) });

    await user.click(
      await screen.findByRole('checkbox', { name: 'organization.security.role.owner' }),
    );

    const first = await openPreview(user);

    await user.click(
      within(first.dialog).getByRole('button', { name: 'organization.security.preview.apply' }),
    );
    await within(first.dialog).findByRole('alert');

    await user.click(
      within(first.dialog).getByRole('button', { name: 'organization.security.preview.cancel' }),
    );
    await user.click(screen.getByRole('checkbox', { name: 'organization.security.role.manager' }));

    const second = await openPreview(user);

    expect(within(second.dialog).queryByRole('alert')).toBeNull();

    await user.click(
      within(second.dialog).getByRole('button', { name: 'organization.security.preview.apply' }),
    );

    await waitFor(() => {
      expect(updateCalls().length).toBeGreaterThan(1);
    });

    const repeat = updateCalls().at(-1);

    // Narrowed with `assert` before the field is read: `expect(x?.body ?? '{}').not.toHaveProperty`
    // is satisfied by a request that was never made at all
    // (`test/architecture/negated-optional-chain.test.ts`).
    assert(repeat !== undefined, 'the second save was never sent');
    // Stated positively as well as negatively: the body is exactly the new draft, so «the flag is
    // absent» cannot pass on a body that is absent too.
    expect(JSON.parse(repeat.body)).toEqual({
      // The draft the second attempt is about: the stored `admin`, plus the two ticked since.
      mfaRequiredForRoles: ['admin', 'owner', 'manager'],
      mfaGracePeriodDays: 3,
    });
  });

  it('shows a genuine refusal in place, as a sentence rather than a code', async () => {
    const user = userEvent.setup();

    await startAt({ update: () => problem('user_forbidden', 403) });

    await user.click(
      await screen.findByRole('checkbox', { name: 'organization.security.role.manager' }),
    );

    const { dialog } = await openPreview(user);

    await user.click(
      within(dialog).getByRole('button', { name: 'organization.security.preview.apply' }),
    );

    const alert = await within(dialog).findByRole('alert');

    expect(alert).toHaveTextContent('organization.security.preview.failed.title');
    expect(alert).toHaveTextContent('errors.code.user_forbidden');
  });
});

describe('the confirmation while it is saving', () => {
  it('cannot be abandoned, so the answer has somewhere to land', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });

    await startAt({
      // The refusal arrives only when this case lets it, so «Escape **while** saving» is a state the
      // test establishes rather than a race it hopes to win.
      update: async () => {
        await inFlight;

        return problem('internal_error', 500);
      },
    });

    await user.click(
      await screen.findByRole('checkbox', { name: 'organization.security.role.manager' }),
    );

    const { dialog } = await openPreview(user);

    await user.click(
      within(dialog).getByRole('button', { name: 'organization.security.preview.apply' }),
    );
    await user.keyboard('{Escape}');

    // Still open, with the request still out: Escape, the cross and a click outside are three ways
    // to the same place, and all three are shut while a `CRITICAL` write is in flight.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'organization.security.preview.close' }),
    ).toBeNull();

    release();

    // The refusal is rendered inside the dialog and nowhere else — a dialog that vanished on Escape
    // would leave the operation failing in silence while its success still speaks.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'organization.security.preview.failed.title',
    );
  });

  it('keeps the apply control reachable when there is nothing to apply, and says so', async () => {
    const user = userEvent.setup();

    await startAt();

    const { dialog } = await openPreview(user);
    const apply = within(dialog).getByRole('button', {
      name: 'organization.security.preview.apply',
    });

    // `aria-disabled`, not `disabled`: a hard one takes the control out of the tab order, and a
    // keyboard user then cannot discover that it exists or why it will not act (`rules/a11y.mdc` §23).
    expect(apply).toHaveAttribute('aria-disabled', 'true');
    expect(apply).toBeEnabled();
    expect(apply).toHaveAccessibleDescription('organization.security.preview.nothingToApply');

    await user.click(apply);

    expect(updateCalls()).toEqual([]);
  });
});

describe('the coverage report', () => {
  it('arrives filtered when the filter is in the address', async () => {
    // The array is spelled the way the router serialises one — `?gate=["grace"]`, encoded. How a
    // list is written into the address bar belongs to TanStack Router's own serialiser, and a test
    // that invented a second spelling would be asserting about a URL the product never produces.
    await startAt({ path: '/admin/organization?tab=security&gate=%5B%22grace%22%5D' });

    expect(await screen.findByText('ada@example.test')).toBeInTheDocument();
    // The URL is the state, so the rows it excludes are not rendered at all — not merely dimmed.
    expect(screen.queryByText('boris@example.test')).toBeNull();
  });

  it('writes the typed phrase into the address, once, after the pause', async () => {
    const user = userEvent.setup();

    const { router } = await startAt();

    await screen.findByText('ada@example.test');
    await user.type(screen.getByLabelText('organization.security.coverage.searchLabel'), 'boris');

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ q: 'boris' });
    });
    // Debounced in the handler: five keystrokes are one write, and `replace` keeps them out of the
    // history — a back button that walked the letters of a word would be the alternative.
    expect(router.history.length).toBe(1);
    await waitFor(() => {
      expect(screen.queryByText('ada@example.test')).toBeNull();
    });
    expect(screen.getByText('boris@example.test')).toBeInTheDocument();
  });

  it('says «nothing matches» rather than «nobody is here» when a filter empties it', async () => {
    await startAt({ path: '/admin/organization?tab=security&q=nobody' });

    expect(await screen.findByText('organization.security.coverage.noMatches')).toBeInTheDocument();
  });

  it('offers a way to clear the filters, and clears them', async () => {
    const user = userEvent.setup();

    const { router } = await startAt({ path: '/admin/organization?tab=security&q=boris' });

    await screen.findByText('boris@example.test');
    await user.click(screen.getByRole('button', { name: 'organization.security.coverage.reset' }));

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ q: '' });
    });
    expect(await screen.findByText('ada@example.test')).toBeInTheDocument();
  });

  it('says «nobody is here» for an organization with no accounts', async () => {
    await startAt({
      coverage: () => json({ policy: POLICY, covered: 0, enrolled: 0, rows: [] }),
    });

    expect(await screen.findByText('organization.security.coverage.empty')).toBeInTheDocument();
  });

  it('reports the failure with a way back rather than an empty table', async () => {
    let recovers = false;

    await startAt({
      coverage: () => (recovers ? json(STANDING_REPORT) : problem('internal_error', 500)),
    });

    await screen.findByTestId('error-state');

    recovers = true;
    await userEvent.setup().click(screen.getByRole('button', { name: 'common.retry' }));

    expect(await screen.findByText('ada@example.test')).toBeInTheDocument();
  });
});

describe('the confirmation dialog', () => {
  it('reports a preview that cannot be read, without applying anything', async () => {
    const user = userEvent.setup();
    let recovers = false;

    await startAt({
      coverage: (search) => {
        if (!search.has('role') && !search.has('graceDays')) return json(STANDING_REPORT);

        return recovers ? json(DRAFT_REPORT) : problem('internal_error', 500);
      },
    });

    await user.click(
      await screen.findByRole('checkbox', { name: 'organization.security.role.manager' }),
    );

    const { dialog } = await openPreview(user);

    await within(dialog).findByTestId('error-state');
    expect(updateCalls()).toEqual([]);

    recovers = true;
    await user.click(within(dialog).getByRole('button', { name: 'common.retry' }));

    expect(await within(dialog).findByText('boris@example.test')).toBeInTheDocument();
  });

  it('takes the focus inside itself when it opens', async () => {
    const user = userEvent.setup();

    await startAt();

    const { dialog } = await openPreview(user);

    await waitFor(() => {
      expect(expectFocusInside(dialog)).toHaveAccessibleName('organization.security.preview.close');
    });
  });

  it('keeps the focus inside itself, in both directions', async () => {
    const user = userEvent.setup();

    await startAt();

    const { dialog } = await openPreview(user);

    expect(
      await focusEscapes(
        user,
        dialog,
        screen.getByRole('checkbox', { name: 'organization.security.role.owner' }),
      ),
    ).toEqual([]);
  });

  it('wraps at both ends rather than swallowing the key', async () => {
    const user = userEvent.setup();

    await startAt();

    const { dialog } = await openPreview(user);

    // The apply button is enabled — the draft differs — so the lap has more than one control in it.
    await user.click(screen.getByRole('checkbox', { name: 'organization.security.role.manager' }));

    expect(await tabWrapFailures(user, dialog)).toEqual([]);
  });

  /**
   * `Esc` abandons the confirmation, and abandoning is the whole of what it does.
   *
   * The absence of the request is the assertion rather than decoration: once the dialog is gone,
   * «Escape closed it» and «Escape applied it» look identical from outside, and the second would
   * put an organization under a policy from a keystroke aimed at the page behind.
   */
  it('abandons on Escape without applying anything, and gives the focus back', async () => {
    const user = userEvent.setup();

    await startAt();

    await user.click(
      await screen.findByRole('checkbox', { name: 'organization.security.role.manager' }),
    );

    const { trigger } = await openPreview(user);

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expectFocusReturnedTo(trigger, 'the control that opens the confirmation');
    });
    expect(updateCalls()).toEqual([]);
  });

  /**
   * The other half of the trap, and the reason the trigger is never disabled.
   *
   * A control disabled by the same state change that closed the dialog receives the returned focus
   * into nothing, and the focus lands on `<body>` — which is the defect
   * `test/architecture/modal-focus-coverage.test.ts` was written after. Here the dialog is closed by
   * a **successful save**, the state change most likely to disable a trigger, and the focus still
   * has somewhere to go.
   */
  it('returns focus to the trigger after a save that closes it', async () => {
    const user = userEvent.setup();

    await startAt();

    await user.click(
      await screen.findByRole('checkbox', { name: 'organization.security.role.manager' }),
    );

    const { trigger, dialog } = await openPreview(user);

    await user.click(
      within(dialog).getByRole('button', { name: 'organization.security.preview.apply' }),
    );

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expectFocusReturnedTo(trigger, 'the control that opens the confirmation');
    });
    expect(trigger).toBeEnabled();
  });
});

describe('accessibility', () => {
  it('finds nothing on the screen itself', async () => {
    await startAt();

    await screen.findByText('ada@example.test');

    expect(await axeViolationsIn(document.body, { control: 'th-has-data-cells' })).toEqual([]);
  });

  it('finds nothing in the confirmation', async () => {
    const user = userEvent.setup();

    await startAt();

    const { dialog } = await openPreview(user);

    await within(dialog).findByText(/boris@example\.test|organization\.security\.preview\.empty/);

    expect(await axeViolationsIn(dialog, { modal: true, control: 'button-name' })).toEqual([]);
  });
});
