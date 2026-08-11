import { type SharedPermissions } from '@bad-crm/shared';

import { errorMessage, isApiError, type ErrorMessage } from '@shared/api';
import { type NotificationRequest } from '@shared/lib';

/**
 * The sentence for a refusal this operation produces, when the error `code` cannot carry it.
 *
 * **Why a second map exists at all.** The client translates by `code`
 * (`rules/errors-and-toasts.mdc` §10), and for two of this endpoint's four refusals that works: a
 * DENY aimed at the owner is `owner_immutable` and a self-lockout is `self_lockout`, both codes of
 * their own with sentences of their own. The other two collapse: `permission_not_granted` and
 * `self_assignment_forbidden` are both answered `user_forbidden`
 * (`server/src/domain/access/access.errors.ts`), because the fifteen refusal reasons of the
 * permission model are deliberately not fifteen error codes. Translated by `code` alone they read
 * «you do not have access to this person» — true of neither: the caller may edit this person, and
 * what they may not do is hand out something they do not hold, or lift a DENY from themselves.
 *
 * So the model's own division of labour is used: **translate by `code`, explain by `reason`**
 * (`permission-model.md` §«Слой 5»; `problem.serializer.ts` carries `reason` as an RFC 9457
 * extension member for exactly this). This map covers only the reasons whose code loses the
 * distinction; everything else falls through to `errorMessageKey`, which is why it is a partial
 * record rather than a `Record<DenyReason, …>` that would have to invent a sentence for
 * `vault_locked`.
 */
export const OVERRIDE_REFUSAL_MESSAGE_KEY: Readonly<
  Partial<Record<SharedPermissions.DenyReason, string>>
> = {
  permission_not_granted: 'permissions.refusal.permissionNotGranted',
  self_assignment_forbidden: 'permissions.refusal.selfAssignmentForbidden',
};

/**
 * The key for a failure of writing or removing an exception, or `undefined` for «nothing better
 * than the code».
 *
 * `undefined` rather than a fallback key, so the caller keeps one decision instead of two: the
 * mutation falls back to `errorMessageKey(error)`, which is the same sentence every other screen
 * shows for that code.
 */
export const overrideRefusalMessageKey = (
  reason: SharedPermissions.DenyReason | undefined,
): string | undefined => (reason === undefined ? undefined : OVERRIDE_REFUSAL_MESSAGE_KEY[reason]);

/**
 * The sentence a failed write or removal shows: the precise one when there is one, the ordinary one
 * otherwise.
 *
 * The fallback is `errorMessage` rather than `errorMessageKey`, so a `rate_limited` keeps the
 * seconds it interpolates — the global handler this replaces would have passed them, and a local
 * handler that silently dropped them would turn «try again in 30 s» into «try again in {{seconds}}
 * s» for one screen only.
 *
 * Returned as a message rather than as a notification because it has **two** renderers, and which
 * one is right depends on where the action was started: a removal is clicked in the table and shows
 * a toast, a write is confirmed inside an `aria-modal` dialog, where a toast would be outside the
 * accessibility tree its reader is confined to (the reasoning `widgets/offboarding` states).
 */
export const overrideRefusalMessage = (error: unknown): ErrorMessage => {
  const precise = isApiError(error) ? overrideRefusalMessageKey(error.reason) : undefined;

  return precise === undefined ? errorMessage(error) : { key: precise };
};

/** The same sentence as a toast — for the removal, which is clicked in the table. */
export const overrideRefusalNotification = (id: string, error: unknown): NotificationRequest => {
  const { key, values } = overrideRefusalMessage(error);

  return { id, messageKey: key, ...(values === undefined ? {} : { values }) };
};
