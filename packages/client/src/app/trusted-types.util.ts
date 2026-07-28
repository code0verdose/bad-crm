/**
 * The Trusted Types policy without which this application does not mount at all.
 *
 * ADR-0023 measured it in a real browser: under `require-trusted-types-for 'script'` Mantine's
 * provider writes its CSS variables and its global classes into a `<style>` element through
 * `innerHTML`; with no policy installed the assignment throws
 * `TypeError: … requires 'TrustedHTML' assignment`, React never mounts, and the page is black.
 * Every header-shaped test passes through that failure, which is why this is asserted as behaviour
 * here and re-checked in a browser.
 *
 * Three properties are deliberate:
 *
 * - **The name is `default`.** The CSP says `trusted-types default`, so this is the only policy the
 *   page may create, and an injected script cannot register a second one to launder its payload.
 * - **Only `createHTML` is defined.** A `default` policy that also defined `createScript` or
 *   `createScriptURL` would hand every unguarded script sink in the page a way through — the exact
 *   sink the directive exists to close. A stylesheet is not a URL and not a script; it needs one
 *   rule, so it gets one.
 * - **It rejects rather than sanitises.** Stripping markup would let a caller that should never
 *   have produced markup keep working, quietly, with a mutated string. The legitimate caller passes
 *   CSS text, which contains no angle bracket at all.
 */

/** Fixed by the `trusted-types default` directive in the CSP; not a preference. */
const POLICY_NAME = 'default';

/**
 * Angle brackets in both directions. `<` alone would be enough to open an element, but a payload
 * split across two assignments can arrive as a closing fragment first, and neither belongs in the
 * only thing this policy is meant to pass: a stylesheet.
 */
const MARKUP = /[<>]/;

interface TrustedTypesFactory {
  readonly createPolicy: (
    name: string,
    rules: { readonly createHTML: (input: string) => string },
  ) => unknown;
}

export const createTrustedHtml = (value: string): string => {
  if (MARKUP.test(value)) {
    throw new TypeError(
      'the default Trusted Types policy refuses a string containing markup: only stylesheet text ' +
        'may be assigned as HTML in this application (ADR-0023)',
    );
  }

  return value;
};

/**
 * Installs the policy. Returns whether the browser had Trusted Types at all, so a caller can tell
 * «installed» from «not supported here» — the second is the normal case in jsdom and in Safari.
 *
 * Called from `main.tsx` before `createRoot`, because the first thing the provider does on mount is
 * exactly the assignment the policy exists for.
 */
export const installTrustedTypesPolicy = (): boolean => {
  const factory = (globalThis.window as { trustedTypes?: TrustedTypesFactory } | undefined)
    ?.trustedTypes;

  if (factory === undefined) return false;

  factory.createPolicy(POLICY_NAME, { createHTML: createTrustedHtml });

  return true;
};
