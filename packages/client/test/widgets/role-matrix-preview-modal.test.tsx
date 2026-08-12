import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The keyboard and the screen reader against «кого затронет» — the second modal in the product.
 *
 * The rules it answers to are not about roles at all. `rules/a11y.mdc` §6 states the whole of it in
 * one sentence — focus enters the dialog, stays in it, `Esc` closes it and the focus goes back to
 * the control that opened it — and `CLAUDE.md` has carried «ловушка фокуса в модалке» as an open
 * EPIC-007 item since the offboarding dialog closed the first half of it. This file is the second.
 *
 * Why the whole screen and not the component alone. Two of the five properties are not the
 * component's at all: the focus goes back to a **trigger**, and the trigger here is the Review
 * button of the draft bar, which is `loading` at the moment the dialog opens. A harness with a plain
 * `<button>` would have proved that Mantine returns focus somewhere — which nobody doubts — and
 * stayed green for the one arrangement the product actually ships. `test/routes/admin-roles-screen.test.tsx`
 * covers the wiring of this screen; what is asserted here is only what a keyboard reaches.
 *
 * `openapi-fetch` captures `globalThis.fetch` when the client module is evaluated, so the stub goes
 * in **before** the import — hence `resetModules` and the dynamic import in `startAt`.
 */

const ROLE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a61';
const SYSTEM_ROLE = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5a62';

/** Enough to read the matrix and to change it — the state in which the summary can be reached. */
const EDITOR = ['role:read', 'role:update', 'task:read', 'task:update'];

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

/**
 * Restored one global at a time, never with `unstubAllGlobals`: the suite's setup stubs
 * `matchMedia`, `ResizeObserver` and `scrollTo` — the parts of the platform jsdom is missing — and
 * clearing every stub takes those with it.
 */
const platformFetch = globalThis.fetch;

const json = (payload: unknown, status = 200): Response =>
  new Response(status === 204 ? null : JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** The server as this screen meets it: permissions, the matrix, the preview and the save. */
const startAt = async (): Promise<void> => {
  vi.resetModules();
  vi.stubGlobal('fetch', async (input: Request) => {
    const url = new URL(input.url).pathname;

    if (url.endsWith('/me/permissions')) {
      return json({
        permissions: EDITOR,
        denied: [],
        roles: ['admin'],
        isOwner: false,
        version: 1,
      });
    }
    if (url.endsWith('/roles/preview-changes')) return json(preview);
    if (url.endsWith('/roles/apply-changes')) return json(null, 204);
    if (url.endsWith('/roles')) return json(roles);

    return json({ status: 'ok' });
  });

  const { renderApp } = await import('../support/render-app.util.js');

  // Narrowed to one permission: the point of every case here is the dialog, and an unfiltered
  // matrix is three hundred rows per render of a screen that gets re-rendered a lot.
  renderApp({ path: '/admin/roles?q=task%3Aupdate', status: 'authenticated' });
};

/**
 * Toggles a cell, asks for the summary, and answers with the dialog **and its trigger**.
 *
 * The trigger is returned rather than looked up again afterwards, because «the element that has the
 * name Review now» is not the same claim as «the element that was clicked»: a control the screen
 * re-created would satisfy the first and fail a keyboard user, who is left where the old node was.
 */
const openSummary = async (
  user: UserEvent,
): Promise<{ dialog: HTMLElement; trigger: HTMLElement }> => {
  // In `cimode` every label renders as its key, so both cells of the row share a name; the first
  // belongs to the editable role, the second to the system one and is disabled.
  const [editable] = await screen.findAllByRole('checkbox', { name: 'roles.cell.label' });

  await user.click(editable as HTMLElement);

  const trigger = await screen.findByRole('button', { name: 'roles.draft.review' });

  await user.click(trigger);

  return { dialog: await screen.findByRole('dialog'), trigger };
};

/** Enough of the focused node to identify it in a failure, and not the whole document. */
const focused = (): string => {
  const element = document.activeElement;

  if (element === null) return 'nothing';

  return `<${element.tagName.toLowerCase()}> ${
    element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? ''
  }`;
};

/**
 * The tabbable controls of an element, in the order the browser walks them.
 *
 * Selector and filter are Mantine's own (`@mantine/hooks/use-focus-trap/tabbable`), because the
 * question these cases ask is «where does the trap take the focus at its own boundary» — computing
 * the boundary differently from the code under test would be asking about a different boundary.
 */
const tabbablesOf = (dialog: HTMLElement): HTMLElement[] =>
  [
    ...dialog.querySelectorAll<HTMLElement>(
      'a, input, select, textarea, button, object, [tabindex]',
    ),
  ]
    .filter((element) => !element.hasAttribute('aria-hidden') && !element.hasAttribute('hidden'))
    .filter((element) => !(element as HTMLButtonElement).disabled)
    .filter((element) => Number(element.getAttribute('tabindex') ?? 0) >= 0);

afterEach(() => {
  vi.stubGlobal('fetch', platformFetch);
});

describe('the role-change summary as a keyboard reaches it', () => {
  /**
   * The names of the three controls, asserted before the two cases below rely on the order.
   *
   * «Tab from the last goes to the first» is a sentence about a list, and a list nobody stated is a
   * list that quietly becomes one element long — at which point wrapping is trivially true and the
   * trap is untested. So the membership is pinned here, and the wrap is pinned there.
   */
  it('offers exactly the close cross, the cancel and the confirm to the keyboard', async () => {
    const user = userEvent.setup();

    await startAt();

    const { dialog } = await openSummary(user);

    expect(
      tabbablesOf(dialog).map(
        (element) => element.getAttribute('aria-label') ?? element.textContent,
      ),
    ).toEqual(['roles.preview.close', 'roles.preview.cancel', 'roles.preview.confirm']);
  });

  it('wraps Tab from the last control back into the dialog, not out of it', async () => {
    const user = userEvent.setup();

    await startAt();

    const { dialog } = await openSummary(user);
    const tabbables = tabbablesOf(dialog);
    const first = tabbables[0] as HTMLElement;
    const last = tabbables[tabbables.length - 1] as HTMLElement;

    last.focus();
    expect(last).toHaveFocus();

    await user.tab();

    expect(first).toHaveFocus();
  });

  it('wraps Shift+Tab from the first control back to the last', async () => {
    const user = userEvent.setup();

    await startAt();

    const { dialog } = await openSummary(user);
    const tabbables = tabbablesOf(dialog);
    const first = tabbables[0] as HTMLElement;
    const last = tabbables[tabbables.length - 1] as HTMLElement;

    first.focus();
    expect(first).toHaveFocus();

    await user.tab({ shift: true });

    expect(last).toHaveFocus();
  });

  /**
   * The property the two cases above imply and neither states: a full lap in each direction never
   * lands on the screen behind the dialog.
   *
   * The control is the search box — a real, enabled, tabbable input that sits before the dialog in
   * the document. Without naming something the focus could have reached, «focus stayed inside» is
   * equally true of a page where nothing outside was focusable to begin with.
   */
  it('never lets the focus reach the screen behind it', async () => {
    const user = userEvent.setup();

    await startAt();

    const { dialog } = await openSummary(user);
    const behind = screen.getByLabelText('roles.searchLabel');

    expect(tabbablesOf(document.body).includes(behind as HTMLElement)).toBe(true);

    for (let step = 0; step < 8; step += 1) {
      await user.tab();
      // Named rather than left as `expected false to be true`: what a reader of the failure needs is
      // which control outside the dialog the focus escaped to.
      expect(
        dialog.contains(document.activeElement),
        `Tab #${step + 1} left the dialog, on ${focused()}`,
      ).toBe(true);
    }

    for (let step = 0; step < 8; step += 1) {
      await user.tab({ shift: true });
      expect(
        dialog.contains(document.activeElement),
        `Shift+Tab #${step + 1} left the dialog, on ${focused()}`,
      ).toBe(true);
    }
  });
});

/**
 * The other half of the trap (`rules/a11y.mdc` §6), once per way out.
 *
 * Both ways are asserted because they are different code paths — `Esc` closes through the dialog's
 * own key handler, the cross through `onClose` — and because the Review button is `loading` while
 * the preview is in flight: a control that is `disabled` at the moment the dialog opens has already
 * lost the focus, and «give it back» then means giving it back to `document.body`.
 */
describe.each([
  [
    'Escape',
    async (user: UserEvent): Promise<void> => {
      await user.keyboard('{Escape}');
    },
  ],
  [
    'the close cross',
    async (user: UserEvent, dialog: HTMLElement): Promise<void> => {
      await user.click(within(dialog).getByRole('button', { name: 'roles.preview.close' }));
    },
  ],
] as const)('closing the summary with %s', (_name, close) => {
  it('gives the focus back to the control that opened it', async () => {
    const user = userEvent.setup();

    await startAt();

    const { dialog, trigger } = await openSummary(user);

    await close(user, dialog);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });
});

describe('the summary as a screen reader meets it', () => {
  /**
   * `aria-modal` is not decoration here: it is what makes everything outside the dialog cease to
   * exist for a reader, which is the premise of the axe exemption below and the reason a refusal
   * has to be rendered inside the dialog rather than as a toast (`rules/errors-and-toasts.mdc` §2).
   */
  it('is a modal dialog, and one a reader can name', async () => {
    const user = userEvent.setup();

    await startAt();

    const { dialog } = await openSummary(user);

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // The role is asserted by the query rather than by an attribute — `getByRole` finds nothing if
    // the element stops being a dialog — and the name comes with it: a dialog announced as «диалог»
    // and nothing else is one a reader has to explore to identify.
    expect(screen.getByRole('dialog', { name: 'roles.preview.title' })).toBe(dialog);
  });

  /**
   * The close cross, named.
   *
   * Mantine renders it as an icon with no text, so without `closeButtonProps` a reader announces
   * «кнопка» and the only way out of a modal dialog is the one control that does not say what it
   * does (`rules/a11y.mdc` §17). The name is asserted directly rather than left to `button-name`
   * inside the axe case below: an aggregate rule that happens to cover a property today is not the
   * same as a test of it, and the failure it prints names a rule instead of naming the control.
   */
  it('names the close cross', async () => {
    const user = userEvent.setup();

    await startAt();

    const { dialog } = await openSummary(user);

    expect(within(dialog).getByRole('button', { name: 'roles.preview.close' })).toBeInTheDocument();
  });

  it('has no accessibility violation', async () => {
    const user = userEvent.setup();

    await startAt();

    const { dialog } = await openSummary(user);

    const { violations, passes } = await axe.run(dialog, {
      rules: {
        // Disabled because jsdom cannot answer it, not because the answer is inconvenient — and the
        // reason is measured below rather than claimed here. jsdom performs no layout, so every node
        // this rule looks at is judged `hidden` and no pair of colours is ever compared; the
        // stylesheet that defines `--bc-*` is never applied either. Left enabled, the rule would
        // report a permanent green that means «nothing was measured». Contrast is checked where it
        // can be: `test/theme/tokens.test.ts` computes every token pair in both schemes, and
        // `@axe-core/playwright` runs the rule against a real engine in e2e.
        'color-contrast': { enabled: false },
        // Disabled with a reason, and the reason is checked rather than asserted: the rule is a
        // **document-level** heuristic — «two banner landmarks on one page» — and it does not model
        // `aria-modal`. While this dialog is open the shell behind it is inert for assistive
        // technology, so its header is not a second banner in any sense a reader experiences. The
        // `aria-modal` case above is what keeps that from being an excuse.
        'landmark-no-duplicate-banner': { enabled: false },
      },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
    // CONTROL: the scan looked at this subtree rather than at nothing. `button-name` is named
    // because it is the rule the close cross would fail without `closeButtonProps`.
    expect(passes.map((rule) => rule.id)).toContain('button-name');
    // The premise of the `landmark-no-duplicate-banner` exemption.
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    // The premise of the `color-contrast` exemption, in two halves. First: the colours are not
    // there. The dialog's surface is `--bc-surface` in the product and transparent here, because the
    // stylesheet that defines the token is never applied in jsdom — so anything the rule read would
    // be a user-agent default rather than a design token.
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
