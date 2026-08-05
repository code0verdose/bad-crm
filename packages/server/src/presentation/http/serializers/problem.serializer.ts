import { type SharedPermissions } from '@bad-crm/shared';
import { problemTypeUrl, type ErrorCode, type ValidationIssue } from '@bad-crm/shared/errors';

/** Media type of RFC 9457 problem documents. Never `application/json`: the shape is a contract. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * RFC 9457 problem document, deliberately **without** `instance`.
 *
 * The field is optional in the RFC, and the only honest value here would be the request URL — which
 * this product cannot print: it has routes whose path segment *is* the credential (`/l/:token`),
 * and a problem document is exactly the thing a user pastes into a ticket. The route template was
 * considered and rejected too: computing it needs a helper that belongs to neither layer that would
 * have to share it. Identity of the occurrence is carried by `requestId`, which correlates to the
 * log line without exposing anything.
 */
export interface ProblemDocument {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly requestId: string;
  /**
   * Why the permission layer refused — present only when it is the one that refused.
   *
   * An extension member, which RFC 9457 allows, rather than a part of `type`: `type` is derived from
   * `code`, and the fifteen refusal reasons are not fifteen codes — `permission_not_granted` and
   * `insufficient_acl_level` are both `role_forbidden` to a client choosing a translation. The
   * client translates by `code` and *explains* by `reason` (`docs/security/permission-model.md`,
   * §«Слой 5»).
   */
  readonly reason?: SharedPermissions.DenyReason;
  /** Present on `validation_failed` only: one entry per rejected field. */
  readonly errors?: readonly ValidationIssue[];
}

export interface ProblemInput {
  readonly code: ErrorCode;
  readonly status: number;
  /** Included only for statuses below 500; see the note about 5xx below. */
  readonly detail?: string | undefined;
  readonly requestId: string;
  readonly reason?: SharedPermissions.DenyReason | undefined;
  readonly errors?: readonly ValidationIssue[] | undefined;
}

/** `task_not_found` → `Task not found`. Human-facing text is the client's job, from `code`. */
const titleOf = (code: ErrorCode): string => {
  const words = code.replaceAll('_', ' ');

  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * One response shape for every failure (stack.md, «Формат ошибок»).
 *
 * `code` is the contract — the client maps it to an i18n key and it never changes meaning.
 * `title`/`detail` are for the developer reading a log and may be reworded at any time, which is
 * exactly why the client must not parse them.
 *
 * **Nothing internal escapes on a 5xx.** For status ≥ 500 the detail is dropped: the message of an
 * unexpected exception is a database error, a driver sentence or a stack frame, and each one hands
 * an attacker a piece of the schema. `requestId` is what connects the user's screenshot to the full
 * story in the log.
 *
 * `errors` is present only when there is something in it. An empty array would tell a client "the
 * request was rejected over these fields: none", and a form written against it would render an
 * empty error list instead of falling back to the top-level `code`.
 */
export const serializeProblem = (input: ProblemInput): ProblemDocument => ({
  type: problemTypeUrl(input.code),
  title: titleOf(input.code),
  status: input.status,
  code: input.code,
  ...(input.status < 500 && input.detail !== undefined ? { detail: input.detail } : {}),
  requestId: input.requestId,
  ...(input.reason === undefined ? {} : { reason: input.reason }),
  ...(input.errors === undefined || input.errors.length === 0 ? {} : { errors: input.errors }),
});
