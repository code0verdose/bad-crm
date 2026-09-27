import { useCallback } from 'react';

import { sectionHeadingOf } from './focus-section-heading.util.js';

/** A row of a table or a list — what a row control belongs to. */
const ROW = 'tr, li, [role="row"]';

/** The same control, by its `data-row-action`, in the row `row` — if that row has one. */
const actionIn = (row: Element | null, action: string): HTMLElement | null =>
  row?.querySelector<HTMLElement>(`[data-row-action="${action}"]`) ?? null;

/** Where focus goes when `element` leaves: the next row, the row above, the section heading. */
const handoffTarget = (element: HTMLElement): HTMLElement | null => {
  const row = element.closest(ROW);
  const action = element.dataset['rowAction'];

  if (row !== null && action !== undefined) {
    const sibling =
      actionIn(row.nextElementSibling, action) ?? actionIn(row.previousElementSibling, action);

    if (sibling !== null) return sibling;
  }

  return sectionHeadingOf(element);
};

/**
 * A ref callback for a control that lives in a row and can take its row off the page — «Remove»
 * in a table whose removal is optimistic.
 *
 * **When the row leaves with focus on its control**, focus goes to the same control in the next
 * row (by `data-row-action`), else the row above, else the heading of the enclosing `Section` —
 * never to `<body>`, where a keyboard or screen reader user would start again from the top
 * (`rules/a11y.mdc` §5). The rule is the one a list reads naturally: carry on down, and when there
 * is nothing below, step back up; when nothing is left, stand on the heading of what was emptied.
 *
 * **When a row comes back** — a refused optimistic removal is rolled back, and the row returns as
 * a *new* node — `takesFocus` is asked on attach, and a `true` puts focus on the new control. The
 * caller decides which row is returning (it knows which removal it started), and answers `true`
 * once: the question is how the intent is cleared.
 *
 * **No effect** (`rules/frontend-fsd.mdc` rule 11), for the reason `useFocusHandoff` has none: the
 * ref cleanup runs while the node is still in the document, so whether it held focus and where its
 * neighbours are can still be read. Focus is moved one microtask later, once the commit has taken
 * the node out, and only if focus was really lost — fell to `<body>` with the node. That one check
 * covers both false alarms: `StrictMode` detaches and re-attaches every new ref once without
 * removing anything (the node keeps focus), and somebody else may have placed focus meanwhile.
 */
export const useRowFocusHandoff = (
  takesFocus: () => boolean,
): ((element: HTMLElement | null) => () => void) =>
  useCallback(
    (element: HTMLElement | null) => {
      // React 19 never calls a ref back with `null` once it has returned a cleanup.
      if (element === null) return () => undefined;
      if (takesFocus()) element.focus();

      return () => {
        if (document.activeElement !== element) return;

        const target = handoffTarget(element);

        queueMicrotask(() => {
          const lost = document.activeElement === null || document.activeElement === document.body;

          if (lost) target?.focus();
        });
      };
    },
    [takesFocus],
  );
