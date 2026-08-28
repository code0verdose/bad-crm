import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { type ReactivationResult } from '@units/employee/api';
import { useReactivateUser } from '@units/employee/service/mutations';
import { errorMessageKey } from '@shared/api';
import { QueryKeys } from '@shared/lib';

export interface ReactivationController {
  /** What the server answered, or `undefined` while nothing has been run yet. */
  readonly result: ReactivationResult | undefined;
  /**
   * The last refusal as a sentence key, rendered where the button was pressed rather than toasted.
   *
   * A key rather than the `Error`: choosing the sentence from the `code` and never from `detail`
   * (`rules/errors-and-toasts.mdc` §10) is a rule about failures, and it is applied on one layer of
   * this client — `service/hooks` — for every confirmation dialog. Handing the dialog an `Error`
   * would let it apply the rule a second time, differently, with nothing turning red.
   */
  readonly failureKey: string | undefined;
  readonly isPending: boolean;
  readonly reactivate: () => void;
  /**
   * The dialog is done with. Refreshes the personnel record **only if something was written**, and
   * clears the answer so the next open starts from the confirmation rather than from a stale report.
   */
  readonly dismiss: () => void;
}

/**
 * Bringing one account back, as the object a dialog can render — the unit's public API for `ui`
 * (`rules/frontend-fsd.mdc` rule 6).
 *
 * **The reason it was written is `dismiss`; the reason it is shaped like its two neighbours is
 * `failureKey`.** All three confirmations in this product — this one, the 2FA reset and the
 * invitation pair — now hand `ui` a ready sentence key, so the rule about reading a failure by its
 * `code` is applied on one layer instead of three.
 *
 * **About `dismiss`.** The mutation deliberately invalidates nothing (see
 * `reactivate-user.mutation.ts`): the card refreshes when the report has been read, not when the
 * request succeeded, because the section the dialog lives in is drawn only while the account is off
 * and a refresh takes the whole dialog off the screen with it. Somebody has to hold that ordering,
 * and it cannot be the widget — a widget that reaches for `queryClient` is a widget that knows about
 * the cache, which is exactly what the call chain forbids (`rules/frontend-fsd.mdc` rule 5).
 *
 * **The whole employee group is invalidated rather than one key.** A return changes the person's
 * row in the directory as well as their card, and `QueryKeys.Employees.all` is the prefix both start
 * with — which is why the factory puts them there (`rules/tanstack-query.mdc` §2). Nothing else in
 * the client holds a query this operation touches: `permissionsVersion` moves, but it invalidates
 * the *subject's* tokens rather than this administrator's cache.
 *
 * **A dismissal that ran nothing refetches nothing.** Cancelling is not an event about the account,
 * and a refetch on every close would spend a request to redraw what is already on screen.
 *
 * Half of the pair the story asks for. The offboarding half is now its neighbour —
 * `use-offboarding.hook.ts`, moved here by `2c5540e` — so the reason this hook once gave for the
 * two living apart no longer holds. Merging them into one `use-employee-lifecycle.hook.ts` is still
 * open, and it is a question of whether one object serving two opposite actions reads better than
 * two, not of who owns which screen.
 */
export const useReactivation = (userId: string): ReactivationController => {
  const queryClient = useQueryClient();
  const reactivation = useReactivateUser();
  const { data, error, isPending, mutate, reset } = reactivation;

  const reactivate = useCallback(() => {
    mutate(userId);
  }, [mutate, userId]);

  const dismiss = useCallback(() => {
    if (data !== undefined) {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.Employees.all });
    }

    reset();
  }, [data, queryClient, reset]);

  return {
    result: data,
    failureKey: error === null ? undefined : errorMessageKey(error),
    isPending,
    reactivate,
    dismiss,
  };
};
