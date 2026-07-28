/**
 * The per-request nonce Mantine puts on every `<style>` element it writes.
 *
 * Why it exists (ADR-0023, «Что измерено»): the policy is `style-src-elem 'self' 'nonce-…'` with no
 * `'unsafe-inline'` — deliberately, because `'unsafe-inline'` would cancel the nonce. Without the
 * nonce the provider's `<style>` is blocked, the page still renders, and only the theme variables
 * and the `visibleFrom`/`hiddenFrom` utilities are missing: a green test suite over broken layout.
 *
 * Where the value comes from: whatever serves `index.html` generates a nonce per request, puts it
 * in the CSP header and in `<meta name="csp-nonce" content="…">` of the same document. That process
 * does not exist yet — Vite serves `index.html` in development and no header is applied to it, and
 * the story that makes the server serve the SPA is the one that adds the substitution. Until then
 * the meta tag is absent and this returns `undefined`, which makes Mantine omit the attribute
 * entirely rather than write `nonce=""` — an empty nonce matches nothing and would block the very
 * element it is meant to allow.
 */
const NONCE_META_SELECTOR = 'meta[name="csp-nonce"]';

export const styleNonce = (): string | undefined => {
  const meta = document.querySelector<HTMLMetaElement>(NONCE_META_SELECTOR);
  const value = meta?.content.trim();

  return value === undefined || value === '' ? undefined : value;
};

/**
 * The global that `get-nonce` reads — the convention, not an invention: `react-style-singleton`
 * calls `getNonce()`, which returns `__webpack_nonce__` from the global scope when nothing was set
 * through its own API. Naming it here is how a bundler-agnostic build reaches a library that only
 * knows the bundler's name for this.
 */
const REMOVE_SCROLL_NONCE_GLOBAL = '__webpack_nonce__';

/**
 * Publishes the nonce to the one style injector Mantine does not own.
 *
 * Measured in a browser, exactly where ADR-0023 said to look («`react-remove-scroll` … его nonce
 * задаётся отдельно. Проверить при первой модалке»): opening the mobile drawer under the real
 * policy produced a `style-src-elem` violation with `blockedURI: inline`. `Drawer` and `Modal` lock
 * the page scroll through `react-remove-scroll`, which injects a `<style>` element of its own at
 * the moment the overlay opens — after the provider has written its styles, and with no knowledge
 * of `getStyleNonce`. Blocked, the lock silently does nothing: the page behind the open drawer
 * keeps scrolling, on the touch devices the drawer exists for.
 *
 * Called once from the bootstrap, before the first render. Returns the nonce so the caller can tell
 * «published» from «no nonce in this document» — which is the normal case in development, where
 * Vite serves `index.html` under no policy at all.
 */
export const installStyleNonce = (): string | undefined => {
  const nonce = styleNonce();

  if (nonce !== undefined) {
    (globalThis as unknown as Record<string, string>)[REMOVE_SCROLL_NONCE_GLOBAL] = nonce;
  }

  return nonce;
};
