export interface CorsOriginOptions {
  /** `APP_URL` — the browser origin this installation is served from. */
  readonly appUrl: string;
  /** `CORS_EXTRA_ORIGINS` — comma-separated additional origins, if the operator configured any. */
  readonly extraOrigins: string | undefined;
}

const originOf = (value: string): string | undefined => {
  try {
    const { origin } = new URL(value);

    // `new URL('not-an-origin:x')` parses, and its origin is the string "null". Treated as invalid:
    // "null" is the origin a sandboxed iframe sends, and it must never be on an allow-list.
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
};

/**
 * The CORS allow-list: the installation's own origin plus whatever `CORS_EXTRA_ORIGINS` adds.
 *
 * A fixed list, never a reflection of the request. `origin: true` with `credentials: true` — the
 * shape this function exists to prevent — lets **any** site the user has open call this API with
 * their session cookie (rules/security.mdc, rule 13). Entries that do not parse are dropped rather
 * than passed through: a typo in the configuration must narrow the list, not widen it.
 */
export const allowedOrigins = (options: CorsOriginOptions): string[] => {
  const configured = [options.appUrl, ...(options.extraOrigins ?? '').split(',')];

  return [
    ...new Set(
      configured
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map((value) => originOf(value))
        .filter((origin): origin is string => origin !== undefined),
    ),
  ];
};

/**
 * Whether a request's `Origin` may read the response.
 *
 * A request with no `Origin` header is not a cross-origin request at all — `curl`, a health probe
 * and a server-to-server call arrive that way, and CORS has nothing to say about them. The browser,
 * the only party CORS protects, always sends the header.
 */
export const isOriginAllowed = (origin: string | undefined, allowed: readonly string[]): boolean =>
  origin === undefined || allowed.includes(origin);
