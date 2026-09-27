import { useCallback } from 'react';

import { firstInvalidField } from '@shared/lib';

/**
 * A ref callback for a `<form>`: when the server's verdict on a submit names fields, focus moves to
 * the first of them in screen order (`order`) — the counterpart of `form.onSubmit(…, onInvalid)`,
 * which does the same for the form's own verdict (`rules/a11y.mdc` §18).
 *
 * A server refusal arrives after the submit handler has returned, so there is no event to hang the
 * move on; and an effect watching the refusal would be the second copy of a state that is read at
 * render (`rules/frontend-fsd.mdc` rule 11). The ref callback is the moment instead: it is
 * re-created when `refusal` changes identity, React calls the new one **after** the commit that
 * drew the messages, and so the field is focused with its error already wired to
 * `aria-describedby` — the screen reader reads the field and why it was refused in one go.
 *
 * **The refusal has to keep its identity between renders** — the caller memoizes it on the
 * mutation's error. A record rebuilt on every render would re-focus the field on every render, and
 * the reader could never leave it. The same holds for `order`: a module constant.
 *
 * Inputs are found by `data-path`, the attribute `@mantine/form` puts on every input it wires, and
 * only inside this form — two forms on one page do not answer for each other.
 */
export const useRefusalFocus = (
  refusal: Readonly<Record<string, unknown>>,
  order: readonly string[],
): ((form: HTMLFormElement | null) => void) =>
  useCallback(
    (form: HTMLFormElement | null) => {
      const field = firstInvalidField(refusal, order);

      if (form === null || field === '') return;

      form.querySelector<HTMLElement>(`[data-path="${CSS.escape(field)}"]`)?.focus();
    },
    [refusal, order],
  );
