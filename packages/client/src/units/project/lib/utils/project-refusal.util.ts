import { type SharedPermissions } from '@bad-crm/shared';

import { errorMessage, isApiError, type ErrorMessage } from '@shared/api';
import { type NotificationRequest } from '@shared/lib';

/**
 * The sentence for a refusal of a project command, when the error `code` cannot carry it.
 *
 * The permission layer collapses its refusal reasons into a handful of codes on the way out —
 * `permission_not_granted`, `insufficient_acl_level` and `self_assignment_forbidden` all reach the
 * client as `user_forbidden` — and translated by `code` alone they would read «you do not have access
 * to this person» on a project screen. **Translate by `code`, explain by `reason`**
 * (`permission-model.md` §«Слой 5»): the same division `units/iam/lib/utils/override-refusal.util.ts`
 * uses, applied to the project's own commands. Partial on purpose — every other reason falls through
 * to `errorMessage`, which is the sentence every other screen shows for that code, `Retry-After`
 * included.
 *
 * This is the «human reason» half of STORY-014-05 acceptance 6: a control the card drew and the
 * server refused says why, once.
 */
export const PROJECT_REFUSAL_MESSAGE_KEY: Readonly<
  Partial<Record<SharedPermissions.DenyReason, string>>
> = {
  permission_not_granted: 'projects.refusal.permissionNotGranted',
  insufficient_acl_level: 'projects.refusal.insufficientLevel',
  self_assignment_forbidden: 'projects.refusal.selfAssignment',
};

export const projectRefusalMessage = (error: unknown): ErrorMessage => {
  const precise =
    isApiError(error) && error.reason !== undefined
      ? PROJECT_REFUSAL_MESSAGE_KEY[error.reason]
      : undefined;

  return precise === undefined ? errorMessage(error) : { key: precise };
};

/**
 * The same sentence as a toast — for the roster commands, clicked in a table row rather than inside
 * a dialog. The values ride along (`rate_limited` carries its seconds), and the id is the caller's,
 * so a repeat of the same refusal updates one toast instead of stacking a second.
 */
export const projectRefusalNotification = (id: string, error: unknown): NotificationRequest => {
  const { key, values } = projectRefusalMessage(error);

  return { id, messageKey: key, ...(values === undefined ? {} : { values }) };
};
