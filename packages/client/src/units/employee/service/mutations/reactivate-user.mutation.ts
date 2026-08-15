import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { reactivateUser, type ReactivationResult } from '@units/employee/api';

/**
 * Bringing an account back, **pessimistically** — and invalidating nothing of its own.
 *
 * No optimistic patch, for the reason its two neighbours give: the answer *is* the result. Whether
 * the account was already on is a fact only the server holds — two tabs, two administrators — and
 * guessing «done» would print a report about a run that wrote nothing.
 *
 * **The refresh of the card is not here, and that is the decision this file exists to record.** The
 * obvious `onSuccess: invalidateQueries(Employees.all)` was written first and is wrong: the section
 * this mutation is called from is drawn only while the account is off, so refetching the personnel
 * record on success flips `status` to `ACTIVE` and unmounts the section — together with the dialog
 * and the report inside it — in the same commit that produced the report. The one thing worth
 * reading would appear and vanish without a frame in between. So the invalidation belongs to the
 * *close* of the dialog, and it lives in `use-reactivation.hook.ts`, which is the thing that knows
 * when the report has been read.
 *
 * The local `onError` is declared so that the global toast stands aside, and for nothing else:
 * `MutationCache.onError` skips a mutation that handles its own failure, which is what makes a local
 * handler an override rather than an addition (`rules/tanstack-query.mdc` §10). The handling is a
 * render — the dialog reads `mutation.error` and shows the refusal in place — and it has to be,
 * because that dialog is `aria-modal="true"`: while it is open a toast in the corner is outside the
 * accessibility tree its reader is confined to. There is nothing to roll back, the mutation being
 * pessimistic, and `logError` still runs on every failure, shown or not.
 */
export const useReactivateUser = (): UseMutationResult<ReactivationResult, Error, string> =>
  useMutation({
    mutationFn: (userId: string) => reactivateUser(userId),
    onError: () => undefined,
  });
