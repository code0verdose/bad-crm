import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTrustedHtml, installTrustedTypesPolicy } from '@app/trusted-types.util.js';

/**
 * The policy that decides whether the application mounts at all.
 *
 * Measured, not assumed (ADR-0023, «Что измерено»): under
 * `require-trusted-types-for 'script'` Mantine's provider writes its CSS variables through
 * `innerHTML`, the assignment throws `TypeError`, React never mounts and the page is black. A test
 * that only asserts the CSP header passes through that failure, which is why the policy itself is
 * asserted here and the rendered page is checked in a real browser.
 */

const withTrustedTypes = (factory: unknown): void => {
  Object.defineProperty(window, 'trustedTypes', {
    value: factory,
    configurable: true,
    writable: true,
  });
};

afterEach(() => {
  Reflect.deleteProperty(window, 'trustedTypes');
});

describe('the default policy', () => {
  it('is installed under the name the CSP directive names', () => {
    const createPolicy = vi.fn();
    withTrustedTypes({ createPolicy });

    expect(installTrustedTypesPolicy()).toBe(true);
    expect(createPolicy).toHaveBeenCalledOnce();
    expect(createPolicy.mock.calls[0]?.[0]).toBe('default');
  });

  /**
   * Defining `createScript` or `createScriptURL` would re-open the sink the directive exists to
   * close: the policy is named `default`, so every unguarded sink in the page would route through
   * whatever it returns.
   */
  it('defines createHTML only, and neither script sink', () => {
    const createPolicy = vi.fn();
    withTrustedTypes({ createPolicy });

    installTrustedTypesPolicy();
    const rules = createPolicy.mock.calls[0]?.[1] as Record<string, unknown>;

    expect(Object.keys(rules)).toEqual(['createHTML']);
  });

  it('does nothing in a browser without Trusted Types, instead of throwing on startup', () => {
    expect(installTrustedTypesPolicy()).toBe(false);
  });
});

describe('createHTML', () => {
  it('passes a stylesheet through — the string a UI kit really writes', () => {
    expect(createTrustedHtml(':root{--mantine-color-brand-6:#44639f;}')).toBe(
      ':root{--mantine-color-brand-6:#44639f;}',
    );
  });

  it.each([
    ['an element', '<img src=x onerror=alert(1)>'],
    ['a closing tag', 'text</style><script>alert(1)</script>'],
    ['a bare angle bracket', 'a < b'],
  ])('rejects %s rather than sanitising it', (_name, value) => {
    expect(() => createTrustedHtml(value)).toThrow(TypeError);
  });
});
