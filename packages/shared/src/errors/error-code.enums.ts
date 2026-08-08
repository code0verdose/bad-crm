/**
 * Stable machine-readable error codes for `application/problem+json` (RFC 9457).
 *
 * `code` is the contract: the client maps it to an i18n key, so a code is never renamed and never
 * reused with a different meaning. `title`/`detail` in the response are for logs and developers —
 * they may change without a major version, `code` may not (stack.md, «Формат ошибок»).
 */

/** Base of the `type` URI. Not dereferenced at runtime; it identifies the problem class. */
export const PROBLEM_TYPE_BASE_URL = 'https://bad-crm.dev/problems';

/**
 * Resources that can be missing, forbidden or duplicated. The list is a closed whitelist so that
 * `task_nto_found` is a compile error rather than a code the client silently fails to translate.
 * A resource is added here by the epic that introduces it, using its glossary name.
 */
export const ERROR_RESOURCES = [
  'organization',
  'team',
  'user',
  'role',
  'invitation',
  /**
   * A login session (`Session` in `data-model.md` §1), as addressed by
   * `DELETE /api/v1/auth/sessions/{sessionId}`. Its ids are enumerable and belong to one person, so
   * "not yours" is answered `session_not_found` rather than `session_forbidden` — the same rule
   * that hides entities of another organization (CLAUDE.md, invariant 2).
   */
  'session',
  'project',
  'board',
  'task',
  'sprint',
  'comment',
  'doc',
  'kb_note',
  'file',
  'vault_item',
  'secure_link',
  'time_entry',
  'channel',
  'message',
  'dashboard',
] as const;

export type ErrorResource = (typeof ERROR_RESOURCES)[number];

/** Codes that are not about one resource, with the HTTP status each one is answered with. */
const GENERIC_ERROR_CODE_STATUS = {
  validation_failed: 422,
  unauthenticated: 401,
  /**
   * A credential was presented and refused: `POST /auth/login` with an email nobody has, with the
   * wrong password, or `POST /auth/change-password` with the wrong `currentPassword`.
   *
   * **One code covers "no such user" and "wrong password", and that is the point** (EPIC-006
   * acceptance). Two codes — or one code with two different `detail` strings — turn the login form
   * into an oracle that answers "does this person work here" for anybody with a word list, which is
   * the first step of every credential-stuffing campaign. The same requirement forbids branching on
   * anything else the caller can observe: status, body and elapsed time are equal in both cases,
   * so the use-case verifies a dummy hash when the user does not exist.
   *
   * Distinct from `unauthenticated` (no token, or an expired one) because the two mean opposite
   * things to the client: `unauthenticated` is answered by refreshing the session, and
   * `invalid_credentials` by telling the person their email or password is wrong.
   */
  invalid_credentials: 401,
  /**
   * The password was correct and the account is not allowed to open a session
   * (`User.status = SUSPENDED`). Reached only *after* a successful verification, so it discloses
   * nothing to somebody who does not already hold the password.
   */
  account_suspended: 403,
  /** Open registration is switched off for this installation and there is nobody to register. */
  registration_disabled: 403,
  /**
   * The password-reset token is unknown, already used, or expired — deliberately one code for all
   * three. Distinguishing them would tell a holder of a random token whether it ever existed, and
   * would let the "already used" answer confirm that somebody completed a reset.
   */
  password_reset_token_invalid: 400,
  /**
   * The invitation link is unknown, revoked, already accepted, expired, or belongs to an
   * organization that has been deactivated — **one code for all five**, and for the same reason as
   * the reset token above: telling them apart would let a holder of a guessed token learn whether it
   * ever existed, and would let «already accepted» confirm that a particular colleague joined
   * (`T-IAM-03`).
   *
   * `410 Gone` rather than 400: the link was a resource with a lifetime, and it is over. The client
   * cannot fix the request by changing it, which is exactly the distinction between 400 and 410 —
   * and the invitation screen shows «ask for a new link» rather than «check what you typed».
   */
  invitation_not_valid: 410,
  /**
   * The operation has to send mail and this installation has no `SMTP_URL`.
   *
   * Not `feature_disabled`: that one means the operator switched an optional subsystem off and the
   * honest answer is "this installation does not do that". Password recovery is not optional — the
   * operator wanted it and the deployment is incomplete, the person on the other end should be told
   * to contact an administrator rather than that the product lacks the feature, and the fix is a
   * configuration change rather than a purchase. Answering "success" without a mail is the failure
   * mode this code exists to prevent (STORY-006-08).
   *
   * **Where it is decided matters as much as which code it is.** On `POST /auth/forgot-password`
   * the whole operation rests on the answer being the same for a registered address and an unknown
   * one; a 503 raised *after* the lookup would be the difference between them, and the code would
   * become the enumeration oracle the 202 was designed not to be. The check is therefore made
   * before the address is resolved — stated in the operation's own description too, because that is
   * where somebody implementing it will look.
   */
  mail_not_configured: 503,
  /**
   * The two transport-level refusals, decided before any resource is identified.
   *
   * `route_not_found` is deliberately *not* spelled as a `<resource>_not_found`: an unmatched path
   * belongs to no resource, and reusing a resource code here would make the client translate
   * "task not found" for a typo in the URL. `payload_too_large` is raised by the body parser at
   * 1 MB (rules/security.mdc, rule 14) — uploads go straight to S3 through a presigned URL, so a
   * request body of that size is a client defect rather than a file.
   */
  route_not_found: 404,
  payload_too_large: 413,
  /** Right present, vault key absent — the server could not help even if it wanted to. */
  vault_locked: 423,
  stale_version: 409,
  idempotency_key_reuse: 409,
  /**
   * The operation would leave the organization without an account nobody can take rights from.
   *
   * Two call sites, one condition: offboarding the owner (STORY-012-05) and removing the owner role
   * from the last holder (STORY-011-04). The name is the one those stories already use — a second code
   * for the same state would make the client translate the same sentence twice.
   *
   * A conflict rather than a denial: the caller may do this and the subject exists, so neither 403 nor
   * 404 is true. The request cannot be satisfied in the current state, and one specific action changes
   * it — transfer ownership first (`domain/identity/access/owner-offboarding.policy.ts`).
   */
  last_owner_required: 409,
  /**
   * The three states a permission cannot argue with, raised by the access layer
   * (`domain/access/access.errors.ts`).
   *
   * Conflicts rather than denials, for the same reason `last_owner_required` above is one: the
   * caller may perform the action, the object exists, and the *current state* refuses. Answering
   * 403 would tell them to ask for a right they already hold.
   *
   * - `period_locked` — approved time and invoiced work are closed; a right does not reopen them.
   * - `self_lockout` — the change would remove the actor's own last way back in.
   * - `system_role_immutable` — the composition of a system role is code, not data.
   */
  period_locked: 409,
  self_lockout: 409,
  system_role_immutable: 409,
  /**
   * A DENY exception aimed at the owner of the organization.
   *
   * A conflict rather than a denial, like the ones above: the caller may write overrides and the
   * subject exists — the state is what refuses, because one such row makes the organization
   * unadministrable. Refused twice, by the use-case and by a trigger, so a direct SQL session cannot
   * write one either.
   */
  owner_immutable: 409,
  /**
   * The operation is allowed and deliberately not performed without a second signal.
   *
   * 428 rather than 403: nothing is missing and nothing is wrong — the caller has the right, and the
   * request would do something whose blast radius is larger than it looks (a role that grants
   * `user:impersonate`, a mass revocation). The client repeats it with the confirmation header, which
   * is why the status has to be one a client can act on rather than one it reports as a failure.
   */
  /** The invitation was accepted: a state conflict, not a missing row and not a refusal. */
  invitation_already_accepted: 409,
  /**
   * The proposed manager reports back to the person being edited. **422**, not 409: the conflict is
   * not with a stored state that somebody else changed — the request as written describes an
   * organization that cannot exist, and the fix is a different value in the field the client sent.
   */
  manager_cycle_detected: 422,
  /**
   * Termination before hiring. **422** for the same reason as the cycle above: the request is well
   * formed, and what it describes is a record that cannot exist.
   */
  employment_period_inverted: 422,
  /**
   * The person the organization would be handed to cannot hold it: suspended, or an invitation
   * nobody has accepted. **409**, not 422 — the request is well formed and the account exists; what
   * is wrong is its state, and the fix is to reactivate them first.
   */
  recipient_not_active: 409,
  /**
   * Handing the organization to oneself. **422**: the value in the field is wrong, and no state
   * anywhere would make it right.
   */
  invalid_recipient: 422,
  /**
   * `organization:transfer_ownership` was held — by role, by a per-user override, or by a custom
   * role — and the holder is not `organizations.owner_id`. **403**, inside the caller's own
   * organization: nothing here is a missing row, so `organization_not_found` would be false, and it
   * is not the generic `organization_forbidden` either, because that sentence says "you lack the
   * right" when the guard already confirmed the opposite. The one fact that decides this operation
   * is who the row currently names, and the code says exactly that (`domain/access/access.errors.ts`).
   */
  not_the_owner: 403,
  confirmation_required: 428,
  rate_limited: 429,
  /**
   * An optional subsystem is switched off in this installation, and the honest answer is "this
   * installation does not do that": search without Meilisearch, the assistant with `AI_ENABLED`
   * off.
   *
   * **SMTP is deliberately not in that list** — it used to be, one line away from the paragraph on
   * `mail_not_configured` that says the opposite, which left the next reader to pick between two
   * statements of this file. The two codes differ in what they promise the caller, which is what
   * the status carries: 501 means the server does not implement this and retrying is pointless,
   * 503 means it would if it could and retrying after the operator acts is the correct behaviour.
   * Password recovery is not an optional feature; a deployment without `SMTP_URL` is incomplete.
   */
  feature_disabled: 501,
  /** A dependency needed to answer is unavailable — including "could not resolve the ACL". */
  service_unavailable: 503,
  internal_error: 500,
} as const;

export type GenericErrorCode = keyof typeof GENERIC_ERROR_CODE_STATUS;

/**
 * Per-resource suffixes.
 *
 * `not_found` covers both "does not exist" and "belongs to another tenant": answering 403 there
 * would turn the API into an oracle of what exists in other organizations (invariant 2 in
 * CLAUDE.md). 403 is reserved for a denial *inside* the caller's own organization.
 */
const RESOURCE_ERROR_SUFFIX_STATUS = {
  not_found: 404,
  forbidden: 403,
  already_exists: 409,
} as const;

export type ResourceErrorSuffix = keyof typeof RESOURCE_ERROR_SUFFIX_STATUS;

export type ResourceErrorCode = `${ErrorResource}_${ResourceErrorSuffix}`;

export type ErrorCode = GenericErrorCode | ResourceErrorCode;

const genericCodes = Object.keys(GENERIC_ERROR_CODE_STATUS) as GenericErrorCode[];
const resourceSuffixes = Object.keys(RESOURCE_ERROR_SUFFIX_STATUS) as ResourceErrorSuffix[];

export const ERROR_CODES: readonly ErrorCode[] = [
  ...genericCodes,
  ...ERROR_RESOURCES.flatMap((resource) =>
    resourceSuffixes.map((suffix): ResourceErrorCode => `${resource}_${suffix}`),
  ),
];

export const ERROR_CODE_STATUS: Readonly<Record<ErrorCode, number>> = {
  ...GENERIC_ERROR_CODE_STATUS,
  ...(Object.fromEntries(
    ERROR_RESOURCES.flatMap((resource) =>
      resourceSuffixes.map(
        (suffix) =>
          [`${resource}_${suffix}`, RESOURCE_ERROR_SUFFIX_STATUS[suffix]] as [
            ResourceErrorCode,
            number,
          ],
      ),
    ),
  ) as Record<ResourceErrorCode, number>),
};

const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(ERROR_CODES);

export const isErrorCode = (value: string): value is ErrorCode => ERROR_CODE_SET.has(value);

export const errorCodeStatus = (code: ErrorCode): number => ERROR_CODE_STATUS[code];

/** `validation_failed` → `https://bad-crm.dev/problems/validation-failed`. */
export const problemTypeUrl = (code: ErrorCode): string =>
  `${PROBLEM_TYPE_BASE_URL}/${code.replaceAll('_', '-')}`;
