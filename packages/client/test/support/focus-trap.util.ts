import { type UserEvent } from '@testing-library/user-event';
import { expect } from 'vitest';

/**
 * The four sentences `rules/a11y.mdc` §6 makes about a modal, as assertions a screen test can reuse.
 *
 * Focus enters the dialog, stays in it in **both** directions, wraps at each boundary, and goes back
 * where it came from. Three of the four were being restated per file — and restated unevenly: five
 * dialogs had a forward-only loop, one had the wrap, none had the entry. An assertion copied five
 * times is five chances to copy it weaker, which is what happened.
 *
 * The pattern is `test/widgets/role-matrix-preview-modal.test.tsx`'s, lifted here the second time it
 * was needed rather than copied a sixth time.
 *
 * What this file deliberately does **not** decide is how a dialog closes: `Esc` is a per-dialog
 * judgement (the recovery-code set refuses it until the codes are saved) and lives with the dialog
 * it is about, not in a helper that would flatten the difference.
 */

/**
 * The tabbable controls of an element, in the order a browser walks them.
 *
 * Selector and filter are Mantine's own (`@mantine/hooks/use-focus-trap/tabbable`), because the
 * question these assertions ask is «where does the trap take the focus at its own boundary» —
 * computing the boundary differently from the code under test would be asking about a different
 * boundary.
 */
export const tabbablesOf = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('a, input, select, textarea, button, object, [tabindex]')]
    .filter((element) => !element.hasAttribute('aria-hidden') && !element.hasAttribute('hidden'))
    .filter((element) => !(element as HTMLButtonElement).disabled)
    .filter((element) => Number(element.getAttribute('tabindex') ?? 0) >= 0);

/** Enough of the focused node to identify it in a failure, and not the whole document. */
export const focused = (): string => {
  const element = document.activeElement;

  if (element === null) return 'nothing';
  if (element === document.body) return '<body> — nowhere';

  return `<${element.tagName.toLowerCase()}> ${
    element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 40) ?? ''
  }`;
};

/**
 * Focus is inside the dialog, and is on a control rather than on the document.
 *
 * `<body>` is named separately because it is the shape the failure actually takes: a trap that never
 * ran leaves focus wherever the click left it, and a click on a control that the same render
 * disables leaves it on `<body>` — which `dialog.contains(...)` alone reports as `false` with no hint
 * of why. Returns the focused element, so a caller can say **which** control it expects.
 */
export const expectFocusInside = (dialog: HTMLElement): HTMLElement => {
  expect(document.activeElement, `focus is on ${focused()}, outside the dialog`).not.toBe(
    document.body,
  );
  expect(
    dialog.contains(document.activeElement),
    `focus is on ${focused()}, outside the dialog`,
  ).toBe(true);

  return document.activeElement as HTMLElement;
};

/**
 * A full lap in each direction, answering **where the focus left the dialog** — an empty list when
 * the trap holds.
 *
 * The verdict is returned rather than asserted, for the reason `axe-scan.util.ts` gives about its
 * own: a helper that swallows both the walk and its conclusion reads, at the call site, like a test
 * with nothing in it. The premises are asserted here because they are the same two every time.
 *
 * `behind` is the first premise and it is not optional: without naming something the focus *could*
 * have reached, «focus stayed inside» is equally true of a page where nothing outside was focusable
 * to begin with. It is asserted to be tabbable before the laps run, so a `behind` that stopped being
 * reachable fails as a broken premise rather than as a green trap.
 *
 * The lap is one step longer than the dialog has controls, so it wraps at least once whatever the
 * dialog contains — a fixed count is a count that stops being a lap the day a field is added.
 */
export const focusEscapes = async (
  user: UserEvent,
  dialog: HTMLElement,
  behind: HTMLElement,
): Promise<string[]> => {
  expect(
    tabbablesOf(document.body).includes(behind),
    'the control behind the dialog is not tabbable — this case would pass on an empty page',
  ).toBe(true);

  const steps = tabbablesOf(dialog).length + 1;
  const escapes: string[] = [];

  for (let step = 0; step < steps; step += 1) {
    await user.tab();
    // Named rather than counted: what a reader of the failure needs is which control outside the
    // dialog the focus escaped to, not that it escaped on the fourth press.
    if (!dialog.contains(document.activeElement)) escapes.push(`Tab #${step + 1} → ${focused()}`);
  }

  for (let step = 0; step < steps; step += 1) {
    await user.tab({ shift: true });
    if (!dialog.contains(document.activeElement)) {
      escapes.push(`Shift+Tab #${step + 1} → ${focused()}`);
    }
  }

  return escapes;
};

/**
 * The boundary itself, answering **how the wrap is wrong** — an empty list when Tab from the last
 * control lands on the first and Shift+Tab from the first lands on the last.
 *
 * Stated separately from the laps above because it is a different failure. A trap that swallowed
 * `Tab` without moving the focus — `preventDefault` and nothing else — passes every lap and leaves a
 * keyboard user stuck on one control, which is the WCAG 2.1.2 trap the rule exists to prevent.
 *
 * The count is the premise: «Tab from the last goes to the first» is a sentence about a list, and a
 * list nobody counted is a list that quietly becomes one element long — at which point wrapping is
 * trivially true and the trap is untested.
 */
export const tabWrapFailures = async (user: UserEvent, dialog: HTMLElement): Promise<string[]> => {
  const tabbables = tabbablesOf(dialog);

  expect(tabbables.length, 'a dialog with one control wraps trivially').toBeGreaterThan(1);

  const first = tabbables[0] as HTMLElement;
  const last = tabbables[tabbables.length - 1] as HTMLElement;
  const failures: string[] = [];

  last.focus();
  expect(last).toHaveFocus();
  await user.tab();
  if (document.activeElement !== first) failures.push(`Tab from the last control → ${focused()}`);

  first.focus();
  expect(first).toHaveFocus();
  await user.tab({ shift: true });
  if (document.activeElement !== last) {
    failures.push(`Shift+Tab from the first control → ${focused()}`);
  }

  return failures;
};

/**
 * The focus came back to the control the dialog was opened from — named, so the failure says where
 * it went instead.
 *
 * `expect(document.activeElement).toBe(trigger)` is the same assertion and prints the entire
 * document when it fails; every one of these lives inside a `waitFor`, so that output is what a
 * reader gets three times over before the timeout.
 */
export const expectFocusReturnedTo = (trigger: Element, description: string): void => {
  expect(
    document.activeElement === trigger,
    `focus is on ${focused()} instead of ${description}`,
  ).toBe(true);
};
