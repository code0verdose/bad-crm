import { apiClient, idempotencyParams, unwrapApiResult, type components } from '@shared/api';

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
  unwrapApiResult(await apiClient.GET('/me/permissions', signal === undefined ? {} : { signal }));

/** Every role of the organization with what it grants — the matrix, in one read. */
export type RoleListEntry = components['schemas']['RoleListEntry'];

/** What one drafted change would do, as the server judges it. */
export type RoleChangeOutcome = components['schemas']['RoleChangeOutcome'];

/** A draft: per role, the composition it should end up with. Not a delta. */
export type RoleChanges = components['schemas']['RoleChanges'];

/** The signal is required, not optional: this is a query, and a query is always cancellable. */
export const fetchRoles = async (signal: AbortSignal): Promise<readonly RoleListEntry[]> =>
  unwrapApiResult(await apiClient.GET('/roles', { signal })).items;

/**
 * No signal: this one is issued by pressing Save, not by a changing query key, so there is no later
 * request that could overtake it — and an option nobody passes is a branch nobody tests.
 */
export const previewRoleChanges = async (
  changes: RoleChanges,
): Promise<readonly RoleChangeOutcome[]> =>
  unwrapApiResult(await apiClient.POST('/roles/preview-changes', { body: changes })).items;

/**
 * Saves the draft. `confirmDangerous` repeats a request the server refused with 428 — the header is
 * the confirmation, and the client sends it only after the person has seen what is dangerous.
 */
export const applyRoleChanges = async (
  changes: RoleChanges,
  options: { readonly confirmDangerous?: boolean } = {},
): Promise<void> => {
  const { params } = idempotencyParams();

  unwrapApiResult(
    await apiClient.POST('/roles/apply-changes', {
      body: changes,
      params: {
        header: {
          ...params.header,
          ...(options.confirmDangerous === true ? { 'X-Confirm-Dangerous': '1' as const } : {}),
        },
      },
    }),
  );
};
