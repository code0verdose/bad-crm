import { useCallback, useRef, useState } from 'react';

import { focusSectionHeading } from '@shared/ui';

export interface Retry {
  /** A reload started by this control is on its way. */
  readonly retrying: boolean;
  /** Starts the reload — once: a press while one is on its way asks for nothing. */
  readonly retry: () => void;
  /** Attach to the retry control; it hands focus on when the control leaves the page. */
  readonly controlRef: (element: HTMLElement | null) => () => void;
}

/**
 * The behaviour of «Retry» in an error state: busy until the reload answers, and where focus goes
 * after.
 *
 * **Focus stays on the control until the outcome.** While the error state stays on screen through
 * the reload — a query that already had data, a route's error boundary under `router.invalidate()`
 * until the answer arrives — the control is the one thing that is certain to be there. A query that
 * fails again leaves the alert exactly as it was, the same element with the same sentence, and a
 * live region that does not change says nothing. Moving focus away at the press left a reader who
 * heard nothing and no longer stood on the control that could tell them. The control is where both
 * outcomes are observable: it goes busy, and it either comes back ready or leaves. (A route's
 * boundary is remounted by the router on the answer, success or failure — the control leaves
 * either way, and where focus goes then is the route announcer's call.)
 *
 * **Focus moves only when the control leaves the page.** A success unmounts the error state and the
 * button with it; so does a reload of a query that never had data, which goes back to `pending` and
 * the skeleton. Either way focus would fall to `<body>`. The ref cleanup runs while the button is
 * still in the document (React detaches refs before it removes the nodes), so the section it sat in
 * can still be found, and its heading takes focus — only if the button *had* focus. That check is
 * for `StrictMode` (how the application mounts), which detaches and re-attaches every new ref once
 * outside the commit: without it each error state would pull focus into its section on appearing.
 * No effect is needed: the moment the control leaves is the moment its ref is detached
 * (`rules/frontend-fsd.mdc` rule 11).
 *
 * **Busy is its own action, not the query's.** `onRetry` returns the reload's promise — a query's
 * `refetch()`, the router's `invalidate()` — and the control is busy until it settles, rejected or
 * not: the failure is the error state's to show, not this hook's. Typed as a promise on purpose, so
 * a caller that swallows it (`() => { void refetch(); }`) is a compile error rather than a button
 * that is never busy.
 */
export const useRetry = (onRetry: () => Promise<unknown>): Retry => {
  const [retrying, setRetrying] = useState(false);
  // The guard reads a ref, not the state: two presses in one tick both see the state before either
  // render, and the second would ask again.
  const inFlight = useRef(false);

  const retry = useCallback(() => {
    if (inFlight.current) return;

    const settle = () => {
      inFlight.current = false;
      setRetrying(false);
    };

    inFlight.current = true;
    setRetrying(true);
    onRetry().then(settle, settle);
  }, [onRetry]);

  // React 19 never calls a ref back with `null` once it has returned a cleanup — it runs the cleanup
  // instead — so `element` here is the mounted node. `null` is only in the signature because the ref
  // type demands it; `activeElement` is never `null` while a document has a body to fall back to.
  const controlRef = useCallback(
    (element: HTMLElement | null) => () => {
      if (document.activeElement === element) focusSectionHeading(element as HTMLElement);
    },
    [],
  );

  return { retrying, retry, controlRef };
};
