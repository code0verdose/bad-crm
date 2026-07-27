import { describe, expect, it } from 'vitest';

import {
  contentSecurityPolicyDirectives,
  serializeContentSecurityPolicy,
} from '../../../src/presentation/http/content-security-policy.util.js';

const directives = (storageEndpoint = 'http://localhost:9000') =>
  contentSecurityPolicyDirectives({ storageEndpoint });

const policy = (storageEndpoint?: string): string =>
  serializeContentSecurityPolicy(directives(storageEndpoint));

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

  it('serializes into a header a browser accepts', () => {
    expect(policy()).toMatch(/^default-src 'self'; /);
    expect(policy()).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy().endsWith(';')).toBe(false);
  });
});
