import { type RefObject, useCallback } from 'react';

/**
 * A ref callback that moves focus to `anchor` when the control that held it **leaves the page** —
 * and only then.
 *
 * `useFocusHandoff` decides in the ref's cleanup, which is right for a control of our own whose ref
 * is stable. A Mantine input merges the ref it is given with its own (`useMergedRef`), and that
 * merged callback is a new function on every render — so its cleanup runs on **every re-render**,
 * with the node still on the page and still focused. Handing focus off there pulls it out of a
 * select the reader is using, the moment an optimistic change re-renders the row.
 *
 * So the cleanup only notes that the node held focus, and the decision waits a microtask: by then a
 * re-render has re-attached the same, still-connected node, while a removed row's node is gone. The
 * case it exists for is a filtered roster, where changing a role can take the row out of the filter
 * (STORY-014-02, acceptance 10).
 */
export const useRemovalFocusHandoff = (
  anchor: RefObject<HTMLElement | null>,
): ((element: HTMLElement | null) => () => void) =>
  useCallback(
    (element: HTMLElement | null) => () => {
      if (element === null || document.activeElement !== element) return;

      queueMicrotask(() => {
        if (!element.isConnected) anchor.current?.focus();
      });
    },
    [anchor],
  );
