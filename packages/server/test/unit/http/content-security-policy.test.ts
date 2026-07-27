import { describe, expect, it } from 'vitest';

import {
  contentSecurityPolicyDirectives,
  serializeContentSecurityPolicy,
} from '../../../src/presentation/http/content-security-policy.util.js';

const directives = (storageEndpoint = 'http://localhost:9000') =>
  contentSecurityPolicyDirectives({ storageEndpoint });

const policy = (storageEndpoint?: string): string =>
  serializeContentSecurityPolicy(directives(storageEndpoint));

const withNonce = (styleNonce: string) =>
  contentSecurityPolicyDirectives({ storageEndpoint: 'http://localhost:9000', styleNonce });

/**
 * ADR-0023 and `docs/security/e2ee-design.md` §12. Every assertion here corresponds to a defect
 * that produces a **green** header test and a black screen in the browser, which is why the policy
 * is assembled by a tested function instead of being typed into the helmet options.
 */
describe('content security policy', () => {
  it('allows WebAssembly compilation, without which the vault does not open at all', () => {
    // `libsodium-wrappers-sumo` is WASM (ADR-0009). Under `script-src 'self'` alone,
    // `WebAssembly.instantiate` throws `CompileError` and the vault cannot be unlocked.
    expect(directives()['script-src']).toContain("'wasm-unsafe-eval'");
  });

  it("never grants 'unsafe-eval', which would re-open eval on the origin that decrypts secrets", () => {
    expect(policy()).not.toContain("'unsafe-eval'");
    expect(policy()).toContain("'wasm-unsafe-eval'");
  });

  it('never grants inline scripts', () => {
    expect(directives()['script-src']).not.toContain("'unsafe-inline'");
  });

  it.each(['connect-src', 'img-src'])(
    '%s carries the object storage origin, so presigned uploads and attachments work',
    (directive) => {
      expect(directives('http://minio.internal:9000')[directive]).toContain(
        'http://minio.internal:9000',
      );
    },
  );

  it('reduces the configured endpoint to an origin, never a path or credentials', () => {
    expect(directives('https://user:pass@s3.example.com/bad-crm/uploads')['img-src']).toContain(
      'https://s3.example.com',
    );
    expect(policy('https://user:pass@s3.example.com/bad-crm/uploads')).not.toContain('pass');
  });

  /**
   * A storage endpoint that cannot be parsed must narrow the policy, never widen it: emitting the
   * raw string would put an attacker-controlled value straight into `connect-src`.
   */
  it('drops an unparseable storage endpoint instead of putting it into the policy', () => {
    expect(policy('not a url')).not.toContain('not a url');
    expect(directives('not a url')['connect-src']).toEqual(["'self'"]);
  });

  it('renders blob: and data: for locally decrypted attachments', () => {
    expect(directives()['img-src']).toEqual(expect.arrayContaining(['data:', 'blob:']));
  });

  it.each([
    ['default-src', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['frame-ancestors', "'none'"],
    ['form-action', "'self'"],
    ['require-trusted-types-for', "'script'"],
  ])('keeps %s at %s', (directive, value) => {
    expect(directives()[directive]).toContain(value);
  });

  /**
   * Everything below was measured in a browser before it was written down, against a production
   * build of React 19 + Mantine served under this exact policy (STORY-004-01). Each assertion
   * corresponds to something that was observed to break — or observed *not* to break, which is why
   * one of the two fixes ADR-0023 predicted is deliberately absent.
   */
  describe('the UI kit renders under it — measured, not assumed', () => {
    it('lets the style elements Mantine injects through by nonce, never by unsafe-inline', () => {
      // `MantineProvider` writes CSS variables and the global classes behind `hiddenFrom` /
      // `visibleFrom` into `<style>` elements it creates at runtime. Under `style-src 'self'` the
      // browser blocks them: the app still renders, so no test of the header notices, but every
      // responsive prop silently stops working. The nonce reaches them through `getStyleNonce`.
      expect(withNonce('c2VjdXJlLXJhbmRvbS0xMjhiaXQ=')['style-src-elem']).toEqual([
        "'self'",
        "'nonce-c2VjdXJlLXJhbmRvbS0xMjhiaXQ='",
      ]);
    });

    it("keeps 'unsafe-inline' out of style-src-elem, which would cancel the nonce", () => {
      expect(withNonce('r4nd0m')['style-src-elem']).not.toContain("'unsafe-inline'");
      expect(serializeContentSecurityPolicy(withNonce('r4nd0m'))).not.toContain("'unsafe-inline'");
    });

    it('emits no nonce token at all when the request carries none', () => {
      expect(directives()['style-src-elem']).toEqual(["'self'"]);
      expect(policy()).not.toContain('nonce-');
    });

    /**
     * A nonce is concatenated into a header, so a value carrying a space, a semicolon or a quote
     * would not be an invalid nonce — it would be an extra directive of the attacker's choosing.
     * Fail closed, exactly as an unparseable storage endpoint does above.
     */
    /**
     * A short nonce is not a weak nonce, it is a placeholder — `"nonce"`, `"dev"`, or a constant
     * reused on every response. The generator lands in STORY-004-03; until then nothing else stands
     * between a stand-in and the header, so the floor lives in the pattern.
     */
    it.each(['a', 'nonce', 'c2hvcnQ='])(
      'drops %o, which is too short to be a real nonce',
      (value) => {
        expect(serializeContentSecurityPolicy(withNonce(value))).not.toContain('nonce-');
      },
    );

    it('drops a nonce that is not a bare token instead of splicing it into the header', () => {
      expect(withNonce("abc'; script-src *")['style-src-elem']).toEqual(["'self'"]);
      expect(serializeContentSecurityPolicy(withNonce('abc def'))).not.toContain('nonce-');
    });

    /**
     * ADR-0023 predicted this directive would need `'unsafe-inline'` because "Mantine ships CSS
     * variables in a `style=""` attribute". Measured in Chrome against the real build: it does not
     * need it. React sets styles through CSSOM (`style.setProperty`), and CSP governs the *parsing*
     * of a style attribute, not a CSSOM write — the attribute is applied with `style-src-attr
     * 'none'` in force and no violation is reported. The token stays out of the policy until
     * something actually emits a style attribute: server-side rendering, or a library that calls
     * `setAttribute('style', …)`. Both are absent (ADR-0005: this is a client-rendered SPA).
     */
    it('blocks style attributes outright, because nothing in a client-rendered SPA writes one', () => {
      expect(directives()['style-src-attr']).toEqual(["'none'"]);
    });

    /**
     * The defect that produced a genuinely black screen: `require-trusted-types-for 'script'` makes
     * every `innerHTML` assignment throw unless a Trusted Types policy converts it, and the
     * `<style>` elements above are written with `dangerouslySetInnerHTML`. React never caught the
     * TypeError, so the whole tree failed to mount. Naming one policy here stops an attacker from
     * registering a permissive one: the first caller to claim `default` wins.
     *
     * The client does not install it yet — STORY-004-03. Until then the state is fail-closed, and
     * the policy that arrives must define `createHTML` only (see the note in the utility).
     */
    it('keeps Trusted Types required and admits exactly one policy name', () => {
      expect(directives()['require-trusted-types-for']).toEqual(["'script'"]);
      expect(directives()['trusted-types']).toEqual(['default']);
    });

    it.each(['media-src', 'frame-src'])(
      '%s carries the object storage origin, so attachments are not blocked by default-src',
      (directive) => {
        // Video and audio attachments, and the PDF preview iframe, are served from presigned
        // storage URLs. Undeclared, both inherit `default-src 'self'` and fail on the first file
        // a user uploads.
        expect(directives('http://minio.internal:9000')[directive]).toContain(
          'http://minio.internal:9000',
        );
      },
    );

    it('never lets an unparseable storage endpoint widen the new directives either', () => {
      expect(directives('not a url')['media-src']).toEqual(["'self'"]);
      expect(directives('not a url')['frame-src']).toEqual(["'self'"]);
    });
  });

  it('serializes into a header a browser accepts', () => {
    expect(policy()).toMatch(/^default-src 'self'; /);
    expect(policy()).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy().endsWith(';')).toBe(false);
  });
});
