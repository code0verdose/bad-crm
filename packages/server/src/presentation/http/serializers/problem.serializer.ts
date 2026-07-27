import { problemTypeUrl, type ErrorCode } from '@bad-crm/shared/errors';

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
  readonly errors?: unknown;
}

export interface ProblemInput {
  readonly code: ErrorCode;
  readonly status: number;
  /** Included only for statuses below 500; see the note about 5xx below. */
  readonly detail?: string | undefined;
  readonly requestId: string;
  readonly errors?: unknown;
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
 */
export const serializeProblem = (input: ProblemInput): ProblemDocument => ({
  type: problemTypeUrl(input.code),
  title: titleOf(input.code),
  status: input.status,
  code: input.code,
  ...(input.status < 500 && input.detail !== undefined ? { detail: input.detail } : {}),
  requestId: input.requestId,
  ...(input.errors === undefined ? {} : { errors: input.errors }),
});
