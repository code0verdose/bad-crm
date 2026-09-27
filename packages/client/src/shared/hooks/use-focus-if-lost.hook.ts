import { useCallback } from 'react';

/**
 * A ref callback for an element that **replaces** the control the reader just used: once `armed`,
 * it takes focus on appearing — but only if focus was lost, that is, fell to `<body>` with the
 * control that held it.
 *
 * The case it exists for is a form that turns into a sentence: adding the last person who could be
 * added replaces the add form with «everyone is already on the project», and the button that was
 * pressed goes with it. `useFocusHandoff` cannot do this — the sentence is not on the page yet when
 * the button's ref is detached — so the sentence claims the focus as it arrives. The element needs
 * `tabIndex={-1}`: focusable by script, not a stop in the tab order.
 *
 * **`armed` is what keeps it from stealing focus on arrival.** A screen that opens with the
 * sentence already there has focus on `<body>` too, before the route announcer has moved it; only
 * the caller knows that the sentence is the outcome of the reader's own action.
 *
 * No effect, for the reason the other handoffs have none (`rules/frontend-fsd.mdc` rule 11): the
 * ref is attached in the commit that inserts the element, which is exactly the moment.
 */
export const useFocusIfLost = (armed: boolean): ((element: HTMLElement | null) => void) =>
  useCallback(
    (element: HTMLElement | null) => {
      if (element === null || !armed) return;

      const lost = document.activeElement === null || document.activeElement === document.body;

      if (lost) element.focus();
    },
    [armed],
  );
