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

/**
 * What **one other person** may do, with the layer of the model that decided each key.
 *
 * The administration counterpart of `MyPermissions` above, and a different shape on purpose: that
 * one is folded to two sets because a guard only needs an answer, this one carries the answer *and*
 * its origin because a screen has to explain it (`permission-model.md` §7(ж)).
 */
export type UserPermissions = components['schemas']['UserPermissions'];

/** One key of the catalogue as it stands for this person: the answer, and who arranged it. */
export type PermissionState = components['schemas']['PermissionState'];

/** The exception in force on one key — reason, author, dates. `null` when there is none. */
export type PermissionOverrideFacts = components['schemas']['PermissionOverrideFacts'];

/** A role the person holds, named as the interface shows it. */
export type HeldRole = components['schemas']['HeldRole'];

/** What writing an exception carries: which way it points, why, and until when. */
export type PermissionOverride = components['schemas']['PermissionOverride'];

/**
 * Every permission of one person, with the origin of each.
 *
 * The signal is required rather than optional, like the other queries here: the key carries the
 * subject, so navigating from one card to another changes it, and a late answer about the previous
 * person must not overwrite a fresh one (`rules/tanstack-query.mdc` §4).
 */
export const fetchUserPermissions = async (
  userId: string,
  signal: AbortSignal,
): Promise<UserPermissions> =>
  unwrapApiResult(
    await apiClient.GET('/users/{userId}/permissions', { params: { path: { userId } }, signal }),
  );

/**
 * Writes the exception on one key — `PUT`, because the pair (person, permission) *is* the row.
 *
 * No `signal`: this is issued by confirming a form, not by a changing query key, so there is no
 * later request that could overtake it — and an option nobody passes is a branch nobody tests.
 *
 * It answers `204` and nothing else, which is why the mutation above it invalidates rather than
 * writing the answer into the cache: the new `source` of the key is a fact only the server can
 * assemble, and guessing it here would be the second permission ladder this screen exists to avoid.
 */
export const writePermissionOverride = async (
  userId: string,
  permission: string,
  override: PermissionOverride,
): Promise<void> => {
  // No `idempotencyParams()`, unlike the two writes next door, and it is not an omission: this
  // operation declares no `Idempotency-Key` parameter (`header?: never` in the generated
  // operation), because `PUT` on the pair (person, permission) is already idempotent — the same
  // exception written twice is the same exception. The middleware still attaches the header to
  // every unsafe request; what would be wrong here is a call site claiming a parameter the contract
  // does not have.
  unwrapApiResult(
    await apiClient.PUT('/users/{userId}/permission-overrides/{permission}', {
      body: override,
      params: { path: { userId, permission } },
    }),
  );
};

/** Removes the exception, putting the person back on whatever their roles say. */
export const removePermissionOverride = async (
  userId: string,
  permission: string,
): Promise<void> => {
  unwrapApiResult(
    await apiClient.DELETE('/users/{userId}/permission-overrides/{permission}', {
      params: { path: { userId, permission } },
    }),
  );
};

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

/** Whom to invite, and what they will hold once they accept. */
export type InvitationDraft = components['schemas']['InvitationDraft'];

/** The answer to creating one: the link, shown exactly once. */
export type MintedInvitation = components['schemas']['MintedInvitation'];

/**
 * Creates an invitation. The response is the only place the link ever exists — the server stores a
 * digest and cannot produce it again.
 *
 * No `signal`: this is issued by pressing a button, not by a changing query key, so there is no
 * later request that could overtake it.
 *
 * The reads and the other two writes of this surface (`GET /invitations`,
 * `POST /invitations/{id}/resend`, `DELETE /invitations/{id}`) exist on the server and are not here
 * yet: the screen that lists open invitations is STORY-012-04, and a client function nobody calls is
 * a contract nobody checks.
 */
export const createInvitation = async (draft: InvitationDraft): Promise<MintedInvitation> => {
  const { params } = idempotencyParams();

  return unwrapApiResult(await apiClient.POST('/invitations', { body: draft, params }));
};
