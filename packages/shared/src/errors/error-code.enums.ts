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
  rate_limited: 429,
  /** Optional subsystem switched off in this installation (search, AI, SMTP). */
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
