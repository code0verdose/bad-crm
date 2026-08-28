import { useCallback } from 'react';

import { type InvitationAcceptance } from '@units/auth/api';
import { useAcceptInvitation } from '@units/auth/service/mutations';
import { resolveTimeZone } from '@shared/lib';

/**
 * What the person chose — the two fields the form owns, and nothing else.
 *
 * Structural rather than the form's own type: that type belongs to `units/iam`, and a unit does not
 * import a sibling. The token comes from the route and the time zone from the browser, so neither is
 * the form's to hand over.
 */
export interface InvitationAcceptanceValues {
  readonly password: string;
  readonly locale: InvitationAcceptance['locale'];
}

export interface InvitationAcceptanceState {
  readonly isPending: boolean;
  /**
   * Accepts it. `onAccepted` fires **only** when the answer really was a session.
   *
   * `adoptSession` returns `null` for a document it cannot parse — a client and server out of step —
   * and a screen that navigated on that answer would drop somebody into the application with no
   * token, where the first guard bounces them back with nothing to explain it.
   */
  readonly accept: (values: InvitationAcceptanceValues, onAccepted?: () => void) => void;
}

/**
 * Accepting an invitation, as the object a public screen can render — the unit's public API for `ui`
 * (`rules/frontend-fsd.mdc` rule 6).
 *
 * **It exists because the page reached past it.** `AcceptInvitePage` called
 * `useAcceptInvitation()` directly, assembled the body from three sources inside its JSX (the
 * route's token, the form's values, the browser's time zone) and kept the «was this actually a
 * session» rule in an `onSuccess` written at the call site. A page is composition — of hooks, not of
 * mutations, and rule 5 keeps request bodies out of markup.
 *
 * The token is bound once, here, so there is no token at the call site to get wrong.
 *
 * No signals of its own: starting the session and announcing it belong to
 * `accept-invitation.mutation.ts`, and a refusal is the single red toast from the global
 * `MutationCache` handler (`rules/errors-and-toasts.mdc` §3).
 */
export const useInvitationAcceptance = (token: string): InvitationAcceptanceState => {
  const { isPending, mutate } = useAcceptInvitation();

  const accept = useCallback(
    (values: InvitationAcceptanceValues, onAccepted?: () => void) => {
      mutate(
        {
          token,
          password: values.password,
          locale: values.locale,
          timezone: resolveTimeZone(),
        },
        {
          onSuccess: (outcome) => {
            if (outcome.identity === null) return;

            onAccepted?.();
          },
        },
      );
    },
    [mutate, token],
  );

  return { isPending, accept };
};
