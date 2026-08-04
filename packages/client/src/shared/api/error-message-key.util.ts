import { type SharedErrors } from '@bad-crm/shared';

import { isApiError } from './problem.errors.js';

/**
 * Every error code, written out, pointing at the sentence that explains it.
 *
 * **Written out rather than assembled.** `errors.${code}` is one line and it is the line ADR-0019
 * forbids: a key composed at runtime is a key no gate can see, so a catalogue missing all of these
 * would pass every check in the repository and render `errors.task_forbidden` at a user. Listing
 * them makes each key a literal the parity gate reads, and `Record<ErrorCode, string>` makes a code
 * added on the server a compile error here — before it can be a missing translation in production.
 *
 * The sentences themselves are in `errors.json`, in both languages, and they are the *only* text
 * shown for a failure. `title` and `detail` from the server are English prose for a log line and
 * may be reworded at any time (`rules/api-contract.mdc` §5).
 */
export const ERROR_MESSAGE_KEY: Readonly<Record<SharedErrors.ErrorCode, string>> = {
  validation_failed: 'errors.code.validation_failed',
  unauthenticated: 'errors.code.unauthenticated',
  invalid_credentials: 'errors.code.invalid_credentials',
  account_suspended: 'errors.code.account_suspended',
  registration_disabled: 'errors.code.registration_disabled',
  password_reset_token_invalid: 'errors.code.password_reset_token_invalid',
  mail_not_configured: 'errors.code.mail_not_configured',
  route_not_found: 'errors.code.route_not_found',
  payload_too_large: 'errors.code.payload_too_large',
  vault_locked: 'errors.code.vault_locked',
  stale_version: 'errors.code.stale_version',
  idempotency_key_reuse: 'errors.code.idempotency_key_reuse',
  last_owner_required: 'errors.code.last_owner_required',
  rate_limited: 'errors.code.rate_limited',
  feature_disabled: 'errors.code.feature_disabled',
  service_unavailable: 'errors.code.service_unavailable',
  internal_error: 'errors.code.internal_error',
  organization_not_found: 'errors.code.organization_not_found',
  organization_forbidden: 'errors.code.organization_forbidden',
  organization_already_exists: 'errors.code.organization_already_exists',
  team_not_found: 'errors.code.team_not_found',
  team_forbidden: 'errors.code.team_forbidden',
  team_already_exists: 'errors.code.team_already_exists',
  user_not_found: 'errors.code.user_not_found',
  user_forbidden: 'errors.code.user_forbidden',
  user_already_exists: 'errors.code.user_already_exists',
  role_not_found: 'errors.code.role_not_found',
  role_forbidden: 'errors.code.role_forbidden',
  role_already_exists: 'errors.code.role_already_exists',
  invitation_not_found: 'errors.code.invitation_not_found',
  invitation_forbidden: 'errors.code.invitation_forbidden',
  invitation_already_exists: 'errors.code.invitation_already_exists',
  session_not_found: 'errors.code.session_not_found',
  session_forbidden: 'errors.code.session_forbidden',
  session_already_exists: 'errors.code.session_already_exists',
  project_not_found: 'errors.code.project_not_found',
  project_forbidden: 'errors.code.project_forbidden',
  project_already_exists: 'errors.code.project_already_exists',
  board_not_found: 'errors.code.board_not_found',
  board_forbidden: 'errors.code.board_forbidden',
  board_already_exists: 'errors.code.board_already_exists',
  task_not_found: 'errors.code.task_not_found',
  task_forbidden: 'errors.code.task_forbidden',
  task_already_exists: 'errors.code.task_already_exists',
  sprint_not_found: 'errors.code.sprint_not_found',
  sprint_forbidden: 'errors.code.sprint_forbidden',
  sprint_already_exists: 'errors.code.sprint_already_exists',
  comment_not_found: 'errors.code.comment_not_found',
  comment_forbidden: 'errors.code.comment_forbidden',
  comment_already_exists: 'errors.code.comment_already_exists',
  doc_not_found: 'errors.code.doc_not_found',
  doc_forbidden: 'errors.code.doc_forbidden',
  doc_already_exists: 'errors.code.doc_already_exists',
  kb_note_not_found: 'errors.code.kb_note_not_found',
  kb_note_forbidden: 'errors.code.kb_note_forbidden',
  kb_note_already_exists: 'errors.code.kb_note_already_exists',
  file_not_found: 'errors.code.file_not_found',
  file_forbidden: 'errors.code.file_forbidden',
  file_already_exists: 'errors.code.file_already_exists',
  vault_item_not_found: 'errors.code.vault_item_not_found',
  vault_item_forbidden: 'errors.code.vault_item_forbidden',
  vault_item_already_exists: 'errors.code.vault_item_already_exists',
  secure_link_not_found: 'errors.code.secure_link_not_found',
  secure_link_forbidden: 'errors.code.secure_link_forbidden',
  secure_link_already_exists: 'errors.code.secure_link_already_exists',
  time_entry_not_found: 'errors.code.time_entry_not_found',
  time_entry_forbidden: 'errors.code.time_entry_forbidden',
  time_entry_already_exists: 'errors.code.time_entry_already_exists',
  channel_not_found: 'errors.code.channel_not_found',
  channel_forbidden: 'errors.code.channel_forbidden',
  channel_already_exists: 'errors.code.channel_already_exists',
  message_not_found: 'errors.code.message_not_found',
  message_forbidden: 'errors.code.message_forbidden',
  message_already_exists: 'errors.code.message_already_exists',
  dashboard_not_found: 'errors.code.dashboard_not_found',
  dashboard_forbidden: 'errors.code.dashboard_forbidden',
  dashboard_already_exists: 'errors.code.dashboard_already_exists',
};

/**
 * The per-field half. `code` at the top of a problem document says the request was rejected; these
 * say which field and why, and a story that translated one and not the other would ship a form that
 * marks an input red and explains nothing.
 */
export const VALIDATION_ISSUE_MESSAGE_KEY: Readonly<
  Record<SharedErrors.ValidationIssueCode, string>
> = {
  invalid_type: 'errors.field.invalid_type',
  too_big: 'errors.field.too_big',
  too_small: 'errors.field.too_small',
  invalid_format: 'errors.field.invalid_format',
  not_multiple_of: 'errors.field.not_multiple_of',
  unrecognized_keys: 'errors.field.unrecognized_keys',
  invalid_union: 'errors.field.invalid_union',
  invalid_key: 'errors.field.invalid_key',
  invalid_element: 'errors.field.invalid_element',
  invalid_value: 'errors.field.invalid_value',
  custom: 'errors.field.custom',
};

/** What a message needs interpolated. Only `rate_limited` carries anything today. */
export interface ErrorMessage {
  readonly key: string;
  readonly values?: Readonly<Record<string, number>>;
}

/**
 * Maps a failure to the sentence that describes it, and never to text.
 *
 * Anything that is not an `ApiError` reached this point without passing the contract — a bug in the
 * bundle, a browser extension, a body that failed to parse. There is no stable code to translate,
 * and rendering the exception message would put a stack sentence in front of a user, so the generic
 * key is the answer. The detail is not lost: the error itself goes to the log.
 */
export const errorMessage = (error: unknown): ErrorMessage => {
  if (!isApiError(error)) return { key: ERROR_MESSAGE_KEY.internal_error };

  // `Retry-After` is part of the 429 response in `docs/api/openapi.yaml`, so the wait is a value the
  // contract already carries rather than a number invented here. Interpolated, not concatenated:
  // «через N с» and «in N s» put the number in different places, and a sentence glued from pieces
  // can only be right in the language it was glued for.
  return error.code === 'rate_limited' && error.retryAfterSeconds !== undefined
    ? { key: ERROR_MESSAGE_KEY.rate_limited, values: { seconds: error.retryAfterSeconds } }
    : { key: ERROR_MESSAGE_KEY[error.code] };
};

/** The key alone, for the places that render a message without interpolating anything. */
export const errorMessageKey = (error: unknown): string => errorMessage(error).key;
