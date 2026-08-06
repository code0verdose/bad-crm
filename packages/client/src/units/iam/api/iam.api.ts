import { apiClient, unwrapApiResult, type components } from '@shared/api';

/** The folded view of the caller's own rights, straight from the contract. */
export type MyPermissions = components['schemas']['MyPermissions'];

/**
 * Pure calls, one per operation — no cache, no state, no notification
 * (`rules/frontend-fsd.mdc` rule 9).
 *
 * `signal` is taken and passed on, unlike the auth calls next door: this one *is* a query, so it is
 * re-issued when its key changes and a stale answer must not overwrite a fresh one
 * (`rules/tanstack-query.mdc` §4).
 */
export const fetchMyPermissions = async (signal?: AbortSignal): Promise<MyPermissions> =>
  unwrapApiResult(
    await apiClient.GET('/me/permissions', signal === undefined ? {} : { signal }),
  );
