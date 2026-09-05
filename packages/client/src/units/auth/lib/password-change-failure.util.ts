import { errorMessageKey, isApiError, VALIDATION_ISSUE_MESSAGE_KEY } from '@shared/api';

/**
 * Where a refused change of password belongs on the screen: under one of the fields, or above all
 * of them.
 */
export interface PasswordChangeFailure {
  /** Field name → i18n key, ready for `form.setErrors` (`rules/errors-and-toasts.mdc` §4). */
  readonly fieldErrors: Readonly<Record<string, string>>;
  /** i18n key of a refusal that belongs to no field, stated above the form. Absent when one does. */
  readonly alertKey: string | undefined;
}

/** The field the contract names for a wrong current password, and the only one it can be. */
const CURRENT_PASSWORD = 'currentPassword';

/** The fields of the form, so a `path` naming something else is not written into a form that has no such input. */
const FIELDS: ReadonlySet<string> = new Set([CURRENT_PASSWORD, 'newPassword', 'confirmPassword']);

/**
 * Sorts one refusal into the place the person can act on.
 *
 * **`401 invalid_credentials` goes under `currentPassword`.** It is the same code a refused sign-in
 * produces, because it is the same fact, and the contract says outright that attaching it to the
 * field is the client's job: «The client attaches the message to the `currentPassword` field; that
 * is a rendering decision, not a contract one». This operation has exactly one credential, so
 * unlike `403 reauthentication_required` next door there is nothing opaque about which field is
 * meant.
 *
 * **A `422` is read from `errors[]` rather than guessed.** The server rejects a policy failure and a
 * new password equal to the old one with the same top-level code, both pointing at `newPassword`,
 * and a rule added later could point elsewhere. The per-field sentence comes from
 * `VALIDATION_ISSUE_MESSAGE_KEY` — the same written-out map the top-level code uses, for the same
 * reason (`rules/i18n.mdc` §9).
 *
 * A `path` naming a field this form does not have is dropped rather than written into the form: it
 * would be an error nothing renders and a submit button that stays refusing with no visible cause.
 * If every issue is dropped that way, the top-level code is stated above the form instead, so the
 * refusal is never silent.
 *
 * Everything else — `429`, a network failure, a 500 — has no field and is stated above the form.
 */
export const passwordChangeFailure = (error: unknown): PasswordChangeFailure => {
  if (!isApiError(error)) return { fieldErrors: {}, alertKey: errorMessageKey(error) };

  if (error.code === 'invalid_credentials') {
    return { fieldErrors: { [CURRENT_PASSWORD]: errorMessageKey(error) }, alertKey: undefined };
  }

  const fieldErrors = Object.fromEntries(
    error.issues
      .filter((issue) => FIELDS.has(issue.path))
      .map((issue) => [issue.path, VALIDATION_ISSUE_MESSAGE_KEY[issue.code]]),
  );

  return Object.keys(fieldErrors).length === 0
    ? { fieldErrors: {}, alertKey: errorMessageKey(error) }
    : { fieldErrors, alertKey: undefined };
};
