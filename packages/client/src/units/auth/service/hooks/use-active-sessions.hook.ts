import { useCallback } from 'react';

import { errorMessage, type ErrorMessage } from '@shared/api';
import { type SessionSummary } from '@units/auth/api';
import { useRevokeOtherSessions } from '@units/auth/service/mutations/revoke-other-sessions.mutation.js';
import { useRevokeSession } from '@units/auth/service/mutations/revoke-session.mutation.js';
import { useSessionListQuery } from '@units/auth/service/queries/session-list.query.js';

export interface ActiveSessions {
  /** Of the list query — the screen owes a skeleton and a retry, like every other read. */
  readonly status: 'pending' | 'error' | 'success';
  readonly items: readonly SessionSummary[];
  /**
   * Whether anything but this device is signed in — what decides that «close every other session»
   * is offered at all.
   *
   * Computed from the answer rather than from `items.length > 1`, because the two differ in the case
   * that matters: a list that has not arrived yet has length zero and no current row either.
   */
  readonly hasOthers: boolean;
  readonly retry: () => Promise<unknown>;
  readonly isRevoking: boolean;
  /** The sentence for a refused revocation, chosen from the `code`. Absent while nothing was refused. */
  readonly failure: ErrorMessage | undefined;
  /**
   * Closes one session. `onRevoked` fires only on success, so the dialog can shut and hand the focus
   * back — and so that a refusal leaves it open with the message in it. Required rather than
   * optional: every caller has a dialog to close, and an optional parameter nothing omits is a
   * branch nothing covers.
   *
   * Takes the whole summary rather than an id: whether the row is the current one decides whether
   * this is a revocation or a sign-out, and that answer belongs to the server (`current`), not to a
   * comparison the client could make against a value that changes on every rotation.
   */
  readonly revoke: (session: SessionSummary, onRevoked: () => void) => void;
  readonly revokeOthers: (onRevoked: () => void) => void;
  /** Forgets the last refusal — the dialog is reused, and a stale message must not open with it. */
  readonly dismissFailure: () => void;
}

/**
 * Where this account is signed in, and the two ways to close it — the unit's public API for `ui`
 * (`rules/frontend-fsd.mdc` rule 6).
 *
 * **One hook over one query and two mutations**, because the screen is one screen: the list, the
 * per-row action and the «close the rest» button share a cache entry, a pending state and a refusal
 * slot, and a widget composing three hooks would be composing them in the layer that is not allowed
 * to know a cache exists (rule 5).
 *
 * **`failure` is one slot for both writes.** Only one confirmation can be open at a time, so only
 * one of them can be the last thing refused; two slots would mean deciding, in the dialog, which of
 * them to believe.
 */
export const useActiveSessions = (): ActiveSessions => {
  const list = useSessionListQuery();
  const one = useRevokeSession();
  const others = useRevokeOtherSessions();

  const items = list.data ?? [];
  /** Only one confirmation can be open, so only one of the two can be the last thing refused. */
  const failure: Error | null = one.error ?? others.error;

  const revoke = useCallback(
    (session: SessionSummary, onRevoked: () => void) => {
      one.mutate({ sessionId: session.id, isCurrent: session.current }, { onSuccess: onRevoked });
    },
    [one],
  );

  const revokeOthers = useCallback(
    (onRevoked: () => void) => {
      others.mutate(undefined, { onSuccess: onRevoked });
    },
    [others],
  );

  return {
    status: list.status,
    items,
    hasOthers: items.some((session) => !session.current),
    retry: () => list.refetch(),
    isRevoking: one.isPending || others.isPending,
    failure: failure === null ? undefined : errorMessage(failure),
    revoke,
    revokeOthers,
    dismissFailure: () => {
      one.reset();
      others.reset();
    },
  };
};
