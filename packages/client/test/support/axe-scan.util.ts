import axe from 'axe-core';
import { expect } from 'vitest';

/**
 * An axe run over one subtree, returning the ids it found — and asserting, on the way, that each
 * exemption this runner forces is still an exemption from a rule that could not have measured
 * anything.
 *
 * The **verdict** is returned rather than asserted here, deliberately: a helper that swallows both
 * the scan and its conclusion reads, at the call site, like a test with nothing in it. The premises
 * are checked here because they are the same three every time; what a given state is allowed to
 * contain is asserted where that state is described.
 *
 * The pattern is `test/widgets/offboarding.test.tsx`'s, lifted here the second time it was needed
 * rather than copied a third time. What it must never become is a place to switch a rule off
 * quietly: every exemption below is accompanied by an assertion that the rule could not have
 * measured anything anyway, so an exemption that stops being true fails instead of passing.
 *
 * - **`color-contrast`.** jsdom performs no layout, so every node the rule looks at is judged
 *   `hidden` and no pair of colours is ever compared; the stylesheet defining `--bc-*` is never
 *   applied either. Left enabled it reports a permanent green meaning «nothing was measured», which
 *   is how a gate stops being believed. Contrast is measured in `test/theme/tokens.test.ts` over
 *   every token pair in both schemes, and by `@axe-core/playwright` against a real engine in e2e.
 * - **`landmark-no-duplicate-banner`, only when scanning a dialog.** It is a document-level
 *   heuristic that does not model `aria-modal`: while a modal is open the shell behind it is inert
 *   for assistive technology, so its header is not a second banner in any sense a reader
 *   experiences. Passing `modal: true` asserts `aria-modal="true"` on the scanned element, which is
 *   the premise; without it the rule stays on.
 */
export const axeViolationsIn = async (
  target: Element,
  { modal = false, control }: { readonly modal?: boolean; readonly control: string },
): Promise<string[]> => {
  if (modal) expect(target).toHaveAttribute('aria-modal', 'true');

  const { violations, passes } = await axe.run(target, {
    rules: {
      'color-contrast': { enabled: false },
      ...(modal ? { 'landmark-no-duplicate-banner': { enabled: false } } : {}),
    },
  });

  // CONTROL: the scan looked at this subtree rather than at nothing. A caller names a rule its
  // markup is known to exercise, so an empty run cannot be mistaken for a clean one.
  expect(passes.map((rule) => rule.id)).toContain(control);

  // The premise of the `color-contrast` exemption: switched on, the rule measures nothing. Every
  // outcome it reports is `hidden` — axe's word for «this node has no box», which without layout is
  // every node.
  const withContrast = await axe.run(target, { runOnly: ['color-contrast'] });
  const measured = withContrast.passes
    .flatMap((rule) =>
      rule.nodes.flatMap((node) =>
        node.any.map((check) => (check.data as { messageKey?: string } | null)?.messageKey),
      ),
    )
    .filter((outcome) => outcome !== 'hidden');

  expect(withContrast.violations).toEqual([]);
  expect(measured).toEqual([]);

  return violations.map((violation) => violation.id);
};
