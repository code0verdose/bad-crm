import { type RefObject, useCallback } from 'react';

/**
 * A ref callback for a control that can take itself off the page: if it held focus when it left,
 * focus moves to `anchor` instead of falling to `<body>`.
 *
 * The case it exists for is taking filters off. «Reset filters» is drawn only while something is
 * filtered, and the cross on a filter chip only while that filter is on — so pressing either removes
 * the very node that had focus, and a keyboard or screen reader user lands at the top of the
 * document with no word about where the list went (`rules/a11y.mdc` §5, §9). The anchor is
 * something the screen always draws; on a list, its search box, which is also where somebody who
 * just cleared the filters starts again.
 *
 * **No effect**, for the reason `useRetry` has none (`rules/frontend-fsd.mdc` rule 11): the moment
 * the control leaves is the moment its ref is detached, and React runs the cleanup a ref callback
 * returns while the node is still in the document — so whether it held focus can still be read off
 * it. The focus check is also what keeps `StrictMode` quiet: it detaches and re-attaches every new
 * ref once, and a control that has only just appeared does not hold focus.
 *
 * An anchor that is not on the page is not an error: focus stays where the browser puts it.
 */
export const useFocusHandoff = (
  anchor: RefObject<HTMLElement | null>,
): ((element: HTMLElement | null) => () => void) =>
  useCallback(
    // React 19 never calls a ref back with `null` once it has returned a cleanup, so `element` is
    // the mounted node; `null` is in the signature only because the ref type demands it.
    (element: HTMLElement | null) => () => {
      if (document.activeElement === element) anchor.current?.focus();
    },
    [anchor],
  );
