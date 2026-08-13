import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { resetUserMfa, type ResetMfaResult } from '@units/employee/api';

/**
 * The administrative 2FA reset, **pessimistically** — and nothing is invalidated afterwards.
 *
 * No optimistic patch, for the reason `useDeactivateUser` gives about its own report: the answer
 * *is* the result — how many recovery codes were destroyed, how many sessions closed, and whether
 * there was a second factor to remove at all — and there is nothing to guess. Guessing here would
 * mean showing «done» for the one call in this operation's life that does nothing (see
 * `wasEnabled` in `docs/api/openapi.yaml`).
 *
 * **No `invalidateQueries`, and that is a decision rather than an omission.** A reset changes three
 * facts about the subject — their TOTP columns, their recovery codes, their live sessions — and the
 * client holds a query for none of them: the personnel document carries no enrolment state (no
 * document in the contract does), the directory row carries none, and the effective-permissions
 * view answers what the person *may do*, which a reset does not touch. `permissionsVersion` moves,
 * but it invalidates the subject's tokens rather than this administrator's cache. Invalidating
 * `Employees.all` «to be safe» would refetch a directory page and a personnel record to redraw
 * exactly what they already show (`rules/tanstack-query.mdc` §2 — the keys exist so that
 * invalidation is aimed, not sprayed).
 *
 * The local `onError` is declared so that the global toast stands aside, and for nothing else:
 * `MutationCache.onError` skips a mutation that handles its own failure, which is what makes a
 * local handler an override rather than an addition (`rules/tanstack-query.mdc` §10). The handling
 * is a render — the dialog reads `mutation.error` and shows the refusal in place — and it has to
 * be, because that dialog is `aria-modal="true"`: while it is open a toast in the corner is outside
 * the accessibility tree its reader is confined to. There is nothing to roll back, the mutation
 * being pessimistic, and `logError` still runs on every failure, shown or not.
 */
export const useResetUserMfa = (): UseMutationResult<ResetMfaResult, Error, string> =>
  useMutation({
    mutationFn: (userId: string) => resetUserMfa(userId),
    onError: () => undefined,
  });
