import {
  errorCodeStatus,
  type ErrorCode,
  type ErrorResource,
  type ValidationIssue,
} from '@bad-crm/shared/errors';

/** Structured extras carried into the `application/problem+json` document, never into a 5xx body. */
export type ErrorDetails = Readonly<Record<string, unknown>>;

/**
 * Base of every failure the application raises on purpose.
 *
 * Two properties make it the only kind of error the HTTP layer has to understand:
 *
 * 1. **`code` comes from the closed catalog in `packages/shared`.** A typo is a compile error, and
 *    the client can map the code to an i18n key without the server ever sending prose
 *    (stack.md, «Формат ошибок»).
 * 2. **`status` is derived from `code`, never passed in.** The mapping code → HTTP lives in one
 *    table shared by the server, the client and (from STORY-003-05) the OpenAPI document, so the
 *    same code cannot be answered 403 in one controller and 404 in the next.
 *
 * Anything that is *not* an `AppError` reaching `error-handler.middleware.ts` is by definition
 * unexpected and is answered `500 internal_error` with no detail.
 */
export abstract class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetails;

  protected constructor(code: ErrorCode, message: string, details?: ErrorDetails, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });

    this.code = code;
    this.status = errorCodeStatus(code);
    this.name = new.target.name;
    if (details !== undefined) this.details = details;
  }
}

/**
 * The resource does not exist — or exists in another organization, which is the same answer.
 *
 * `route_not_found` is included because an unmatched path is not about a resource at all; see the
 * catalog comment in `packages/shared/src/errors/error-code.enums.ts`.
 */
export class NotFoundError extends AppError {
  constructor(code: `${ErrorResource}_not_found` | 'route_not_found', details?: ErrorDetails) {
    super(code, `Resource not found: ${code}`, details);
  }
}

/**
 * No usable session, or a credential that was presented and refused.
 *
 * **The two codes are one class on purpose, and `message` is a constant.** `invalid_credentials`
 * covers an address nobody has *and* a wrong password, and the epic's acceptance criterion is that
 * nothing the caller can observe separates them — not the status, not the code, not the `detail`
 * line the error handler builds out of `message`, and not the elapsed time (which the login use-case
 * equalises by verifying a dummy digest). A constructor taking a per-case message would put the
 * oracle back one throw site at a time, so it does not take one.
 */
export class UnauthenticatedError extends AppError {
  constructor(code: 'unauthenticated' | 'invalid_credentials' = 'unauthenticated') {
    super(code, code === 'unauthenticated' ? 'Unauthenticated' : 'Invalid credentials');
  }
}

/**
 * The credential was right and the account may still not do this.
 *
 * `account_suspended` is reachable only *after* a password verified, and `registration_disabled` is
 * decided before any address is looked at. Both are properties of the installation or of the
 * account rather than of the request, which is why neither is a `ForbiddenError`: that one is about
 * a capability inside an organization, and there is no organization here yet.
 */
export class AccountRefusedError extends AppError {
  constructor(code: 'account_suspended' | 'registration_disabled', details?: ErrorDetails) {
    super(code, `Refused: ${code}`, details);
  }
}

/**
 * The caller may see the resource but not perform this action **inside their own organization**.
 *
 * A denial that crosses organizations is a `NotFoundError`; the choice is made once, in
 * `access-denial.util.ts`, and not at the throw site.
 */
export class ForbiddenError extends AppError {
  constructor(code: `${ErrorResource}_forbidden`, details?: ErrorDetails) {
    super(code, `Access denied: ${code}`, details);
  }
}

/** The request collides with the current state: duplicate key, stale version, replayed key. */
export class ConflictError extends AppError {
  constructor(
    code:
      | `${ErrorResource}_already_exists`
      | 'stale_version'
      | 'idempotency_key_reuse'
      | 'last_owner_required'
      // «The change would remove the actor's own last way back in» — a state, not a permission, so a
      // conflict rather than a denial (`error-code.enums.ts`, `self_lockout: 409`). Reached first by
      // offboarding; the role matrix raises it as a `Decision` instead, because there the refusal is
      // one cell of a larger judgement rather than the whole answer.
      | 'self_lockout'
      // The recipient of an ownership transfer is suspended or has never signed in: a state, and
      // one with a specific next step — reactivate them, then transfer.
      | 'recipient_not_active',
    details?: ErrorDetails,
  ) {
    super(code, `Conflicting request: ${code}`, details);
  }
}

/** `1 field is invalid` / `3 fields are invalid` — the `detail` line of the problem document. */
const describeIssueCount = (count: number): string =>
  count === 1 ? '1 field is invalid' : `${count} fields are invalid`;

/**
 * Input rejected at the boundary, with the list of fields that caused it.
 *
 * `issues` is a first-class property rather than one more entry in `details` because it is the one
 * part of an error body the client *acts* on: a form maps `path` to an input and `code` to a
 * message. Keeping it separate is what lets the serializer put it in `errors[]` — the array the
 * OpenAPI document declares — while `details` stays what it has always been: developer context for
 * the log, never for the response.
 */
export class ValidationError extends AppError {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[] = [], cause?: unknown) {
    super('validation_failed', describeIssueCount(issues.length), undefined, cause);

    this.issues = issues;
  }
}

/**
 * Too many requests. `retryAfterSeconds` becomes the `Retry-After` header.
 *
 * A 429 without that header tells a client to back off without saying for how long, and the client
 * that guesses is the client that retries in a tight loop — the limiter then spends its budget on
 * the caller it was meant to slow down. The limiter itself arrives with the auth surface; this is
 * the error it will raise, and the header is wired in the handler so it cannot be forgotten there.
 */
export class RateLimitedError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, details?: ErrorDetails) {
    super('rate_limited', 'Too many requests', details);

    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * An operation that has to send mail ran on an installation with no `SMTP_URL`.
 *
 * `503`, not `501 feature_disabled`: nobody switched password recovery off, the deployment is
 * incomplete — the reasoning is written out in the catalog entry in
 * `packages/shared/src/errors/error-code.enums.ts`, and the alternative it exists to prevent is
 * answering success to a request whose whole effect was a message that never left.
 *
 * **Where it is raised is part of its meaning.** On `POST /auth/forgot-password` it is decided
 * before the address is resolved, so the choice between 503 and 202 depends on the installation and
 * never on whether the address is registered; raised after the lookup it would be the enumeration
 * oracle the constant 202 was designed not to be (`docs/api/openapi.yaml`, `requestPasswordReset`).
 */
export class MailNotConfiguredError extends AppError {
  constructor(details?: ErrorDetails) {
    super('mail_not_configured', 'This installation cannot send mail', details);
  }
}

/**
 * The reset token is unknown, already spent, or expired — one error for all three.
 *
 * It takes no argument saying *which*, and that is the point: a constructor with a reason would put
 * the distinction one throw site away from the response, and telling the three apart lets a holder
 * of a guessed token learn whether it ever existed and lets "already used" confirm that somebody
 * completed a reset.
 */
export class PasswordResetTokenInvalidError extends AppError {
  constructor() {
    super('password_reset_token_invalid', 'The password reset link is not usable');
  }
}

/**
 * The invitation link cannot be used: unknown, revoked, accepted, expired, or its organization was
 * deactivated. **One error for all five** — see the code's own note in
 * `packages/shared/src/errors/error-code.enums.ts`.
 */
export class InvitationNotValidError extends AppError {
  constructor() {
    super('invitation_not_valid', 'The invitation link is not usable');
  }
}

/** The body exceeded the 1 MB limit; files never travel through the API (ADR-0015). */
export class PayloadTooLargeError extends AppError {
  constructor(details?: ErrorDetails, cause?: unknown) {
    super('payload_too_large', 'Request body is too large', details, cause);
  }
}

/**
 * The caller may do this, and is being asked to say so twice.
 *
 * 428 rather than 403: nothing is missing — the right is held and the request is well formed. What
 * the second signal buys is that somebody saw the list before it was stored, because the blast
 * radius of a dangerous permission inside a role is larger than the click that adds it looks.
 *
 * **The response body carries no list**, deliberately. Which keys are dangerous is in the shared
 * catalogue (`PERMISSION_META[...].dangerous`), so the client already has it and can name them in
 * its own language; sending them back would be the server translating its own catalogue into a
 * response nobody needs. The keys are passed as `details` all the same — `details` is developer
 * context that reaches the log and never the body (`error-handler.middleware.ts`), and «which key
 * made this request stop» is exactly what the log is read for afterwards.
 */
export class ConfirmationRequiredError extends AppError {
  constructor(details?: ErrorDetails) {
    super('confirmation_required', 'This operation needs an explicit confirmation', details);
  }
}

/**
 * A dependency needed to answer is unavailable.
 *
 * The driver exception is kept as `cause` — it belongs in the log, where the error serializer can
 * strip its headers, and never in a response body: connection errors quote connection strings, and
 * connection strings quote passwords.
 */
export class ServiceUnavailableError extends AppError {
  constructor(details?: ErrorDetails, cause?: unknown) {
    super('service_unavailable', 'A dependency is unavailable', details, cause);
  }
}
