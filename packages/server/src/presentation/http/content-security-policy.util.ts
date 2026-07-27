export interface ContentSecurityPolicyOptions {
  /** `S3_ENDPOINT` of this installation; reduced to an origin before it enters the policy. */
  readonly storageEndpoint: string;
  /**
   * Per-request nonce for the `<style>` elements the UI kit creates at runtime, or nothing while
   * the document is served by the Vite dev server rather than by this process.
   */
  readonly styleNonce?: string;
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
 * A nonce is concatenated straight into the header, so anything but a bare token is a directive
 * injection: `abc'; script-src *` would end the source list and start one of the caller's choosing.
 * Base64 (`+/=`) and base64url (`-_`) are what a generator produces; everything else is refused.
 */
// 22 characters is 128 bits of base64 — the floor RFC 8674 asks of a nonce, and the reason the
// length is in the pattern rather than in a comment: without it `"a"` validates, and so does a
// placeholder or a constant reused on every response. The generator does not exist yet
// (STORY-004-03), so nothing else stands between a stand-in value and the header.
const NONCE_TOKEN = /^[A-Za-z0-9+/=_-]{22,}$/;

/** The nonce source expression, or nothing — an unusable nonce narrows the policy, never widens it. */
const nonceSource = (nonce: string | undefined): string[] =>
  nonce !== undefined && NONCE_TOKEN.test(nonce) ? [`'nonce-${nonce}'`] : [];

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
 * Three more were added by STORY-004-01, when the first real browser render existed to check the
 * policy against. All three were *measured* in Chrome on a production build of React 19 + Mantine
 * served under this header, not reasoned about — two of them behaved differently from what the
 * "known gap" section of ADR-0023 predicted:
 *
 * - **`style-src-elem` with a nonce.** `MantineProvider` writes CSS variables and the global
 *   classes behind `hiddenFrom` / `visibleFrom` into `<style>` elements it creates at runtime.
 *   Under `style-src 'self'` the browser drops them and the application still renders — so nothing
 *   fails except every responsive prop, silently. The nonce is the narrow fix: `'unsafe-inline'`
 *   would also admit any `<style>` block an injection manages to write.
 * - **`style-src-attr 'none'`, not `'unsafe-inline'`.** The predicted breakage did not happen:
 *   React applies the `style` prop through CSSOM (`style.setProperty`), and CSP governs the
 *   parsing of a style attribute rather than a CSSOM write. Measured with `'none'` in force, the
 *   attribute is applied and no violation is reported. The token would only be needed for
 *   server-side rendering or a library calling `setAttribute('style', …)`; this is a
 *   client-rendered SPA (ADR-0005) and has neither.
 * - **`trusted-types default`.** This is the defect that produced an actually black screen:
 *   `require-trusted-types-for 'script'` makes every `innerHTML` assignment throw, the `<style>`
 *   elements above are written with `dangerouslySetInnerHTML`, and the uncaught `TypeError` took
 *   the whole React tree down before first paint. Naming the policy here means an injected script
 *   cannot register a permissive one of its own — the first caller to claim `default` wins, and
 *   `trusted-types default` allows exactly that one name.
 *
 *   The client does **not** install that policy yet — it lands in STORY-004-03, with the UI-kit.
 *   Until then the state is fail-closed and measured: `innerHTML` throws `TrustedHTML`, `script.src`
 *   throws `TrustedScriptURL`. The policy, when it arrives, defines `createHTML` and **nothing
 *   else**: a script URL contains no markup, so a policy that only rejects `<` and `>` would wave
 *   `createScriptURL` through — leaving the sink undefined keeps it closed with an explicit error.
 *
 * `media-src` and `frame-src` are here for the same reason `connect-src` and `img-src` already
 * were: video and audio attachments and the PDF preview iframe load from presigned storage URLs,
 * and an undeclared directive inherits `default-src 'self'`.
 *
 * No nonce is emitted for `script-src`: a Vite build references its entry as
 * `<script type="module" src="…">` and ships no inline script, so there is nothing to sign.
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
    // Kept as the fallback for the directives below, and for a browser that knows neither.
    'style-src': ["'self'"],
    'style-src-elem': ["'self'", ...nonceSource(options.styleNonce)],
    'style-src-attr': ["'none'"],
    'connect-src': withStorage("'self'"),
    'img-src': withStorage("'self'", 'data:', 'blob:'),
    'media-src': withStorage("'self'"),
    'frame-src': withStorage("'self'"),
    'font-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'require-trusted-types-for': ["'script'"],
    'trusted-types': ['default'],
  };
};

/** The directives as the header value, for assertions and for logging the effective policy. */
export const serializeContentSecurityPolicy = (
  directives: ContentSecurityPolicyDirectives,
): string =>
  Object.entries(directives)
    .map(([directive, sources]) => [directive, ...sources].join(' '))
    .join('; ');
