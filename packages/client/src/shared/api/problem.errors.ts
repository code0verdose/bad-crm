import { SharedErrors } from '@bad-crm/shared';

/**
 * `application/problem+json` (RFC 9457) on the wire, one typed error in the application.
 *
 * The field that matters is `code`. It is a closed catalog shared with the server
 * (`packages/shared/src/errors/error-code.enums.ts`, mirrored as an `enum` in the specification), it
 * never changes meaning, and it is what the UI translates. `title` and `detail` are English prose
 * for a log line and may be reworded at any time — showing either to a user is how "Validation
 * failed" and a Prisma exception end up in a toast (`rules/api-contract.mdc` §5,
 * `rules/errors-and-toasts.mdc` §10).
 */
export interface ApiErrorInit {
  readonly code: SharedErrors.ErrorCode;
  readonly status: number;
  /** Correlates the failure with the server log; safe to show in a support ticket. */
  readonly requestId: string;
  /** Per-field issues of a `validation_failed`; empty for every other code. */
  readonly issues: readonly SharedErrors.ValidationIssue[];
  /** Seconds left on a `rate_limited` counter, from `Retry-After`; absent for every other code. */
  readonly retryAfterSeconds?: number;
}

export class ApiError extends Error {
  readonly code: SharedErrors.ErrorCode;
  readonly status: number;
  readonly requestId: string;
  readonly issues: readonly SharedErrors.ValidationIssue[];
  readonly retryAfterSeconds?: number;

  constructor(init: ApiErrorInit) {
    // Deliberately not the server `detail`: this string reaches logs and failing tests, and a
    // message a developer might be tempted to render is a message that eventually gets rendered.
    super(`${init.code} (HTTP ${init.status}, request ${init.requestId})`);

    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
    this.issues = init.issues;
    if (init.retryAfterSeconds !== undefined) this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

export const isApiError = (value: unknown): value is ApiError => value instanceof ApiError;

interface ProblemDocument {
  readonly code: SharedErrors.ErrorCode;
  readonly requestId: string;
  readonly errors?: readonly SharedErrors.ValidationIssue[];
}

/**
 * A body is a problem document only if it carries a code this client can act on.
 *
 * Anything else — a gateway's HTML, a proxy's plain text, a future code this build has never heard
 * of — is not trusted into `code`, because `code` selects an i18n key and an unknown one resolves to
 * nothing. The honest answer for those is `internal_error`: the request failed and the reason has no
 * translation here.
 */
const asProblemDocument = (body: unknown): ProblemDocument | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;

  const candidate = body as { code?: unknown; requestId?: unknown; errors?: unknown };

  if (typeof candidate.code !== 'string' || !SharedErrors.isErrorCode(candidate.code)) {
    return undefined;
  }
  if (typeof candidate.requestId !== 'string') return undefined;

  return {
    code: candidate.code,
    requestId: candidate.requestId,
    ...(Array.isArray(candidate.errors)
      ? { errors: candidate.errors as readonly SharedErrors.ValidationIssue[] }
      : {}),
  };
};

/**
 * The status always comes from the response rather than from the body: the two are supposed to
 * agree, and when they do not, the one the browser acted on is the truthful one.
 */
/**
 * `Retry-After` as a number of seconds, or nothing.
 *
 * RFC 9110 allows an HTTP-date here as well as a delay; this server always sends the delay
 * (`error-handler.middleware.ts`), and a date would parse to `NaN` — which must not reach a message
 * as «try again in NaN s». Anything that is not a finite, non-negative number is treated as absent,
 * and the sentence without a wait is shown instead.
 */
const retryAfterOf = (response: Response): number | undefined => {
  const header = response.headers.get('retry-after');

  if (header === null) return undefined;

  const seconds = Number(header);

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
};

export const apiErrorOf = (body: unknown, response: Response): ApiError => {
  const problem = asProblemDocument(body);
  const retryAfterSeconds = retryAfterOf(response);

  return new ApiError({
    code: problem?.code ?? 'internal_error',
    status: response.status,
    requestId: problem?.requestId ?? response.headers.get('x-request-id') ?? '',
    issues: problem?.errors ?? [],
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
};
