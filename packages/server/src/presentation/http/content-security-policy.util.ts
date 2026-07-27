export interface ContentSecurityPolicyOptions {
  /** `S3_ENDPOINT` of this installation; reduced to an origin before it enters the policy. */
  readonly storageEndpoint: string;
}

export type ContentSecurityPolicyDirectives = Readonly<Record<string, readonly string[]>>;

/** Origin of a URL, or `undefined` if it cannot be parsed — a bad value must not widen the policy. */
const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/**
 * The Content-Security-Policy of the whole application, assembled from configuration.
 *
 * **The application builds this header, not the reverse proxy** ([ADR-0023](
 * ../../../../../docs/architecture/adr/0023-csp-for-wasm-crypto.md), `docs/security/e2ee-design.md`
 * §12). Three of the decisions below are invisible to any test that merely asserts the header
 * exists, and each one breaks the product in a browser:
 *
 * - **`'wasm-unsafe-eval'` in `script-src`.** The vault crypto module is `libsodium-wrappers-sumo`,
 *   i.e. WebAssembly. Without the token `WebAssembly.instantiate` throws `CompileError` and the
 *   vault does not open at all. It permits *only* WASM compilation: `eval()` and `new Function`
 *   stay forbidden, which is why `'unsafe-eval'` is never used — it would re-open exactly the
 *   primitive this policy exists to close, on the origin where the master key is decrypted.
 * - **The object storage origin in `connect-src` and `img-src`.** Presigned URLs point at MinIO/S3,
 *   not at our origin: without it the presigned `PUT` of an upload and every image attachment are
 *   blocked. It comes from configuration because in a self-hosted installation it is different
 *   every time.
 * - **No `Cross-Origin-Embedder-Policy`** — see `http-server.factory.ts`, where helmet is
 *   configured; `require-corp` would silently break every presigned image.
 *
 * The nonce for the single inline script of the Vite build is added by EPIC-004, per request.
 */
export const contentSecurityPolicyDirectives = (
  options: ContentSecurityPolicyOptions,
): ContentSecurityPolicyDirectives => {
  const storageOrigin = originOf(options.storageEndpoint);
  const withStorage = (...sources: string[]): string[] =>
    storageOrigin === undefined ? sources : [...sources, storageOrigin];

  return {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'style-src': ["'self'"],
    'connect-src': withStorage("'self'"),
    'img-src': withStorage("'self'", 'data:', 'blob:'),
    'font-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'require-trusted-types-for': ["'script'"],
  };
};

/** The directives as the header value, for assertions and for logging the effective policy. */
export const serializeContentSecurityPolicy = (
  directives: ContentSecurityPolicyDirectives,
): string =>
  Object.entries(directives)
    .map(([directive, sources]) => [directive, ...sources].join(' '))
    .join('; ');
