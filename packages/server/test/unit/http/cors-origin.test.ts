import { describe, expect, it } from 'vitest';

import {
  allowedOrigins,
  isOriginAllowed,
} from '../../../src/presentation/http/cors-origin.util.js';

describe('CORS allow-list', () => {
  it('always contains the origin of the installation itself', () => {
    expect(allowedOrigins({ appUrl: 'https://crm.example.com', extraOrigins: undefined })).toEqual([
      'https://crm.example.com',
    ]);
  });

  it('reduces APP_URL to an origin, because a browser sends an origin and not a URL', () => {
    expect(
      allowedOrigins({ appUrl: 'https://crm.example.com/app/', extraOrigins: undefined }),
    ).toEqual(['https://crm.example.com']);
  });

  it('adds the comma-separated extras an installation configured', () => {
    expect(
      allowedOrigins({
        appUrl: 'https://crm.example.com',
        extraOrigins: 'https://desktop.example.com, https://staging.example.com',
      }),
    ).toEqual([
      'https://crm.example.com',
      'https://desktop.example.com',
      'https://staging.example.com',
    ]);
  });

  it('ignores blanks and duplicates rather than producing a broken header', () => {
    expect(
      allowedOrigins({
        appUrl: 'https://crm.example.com',
        extraOrigins: ' , https://crm.example.com ,, https://desktop.example.com ',
      }),
    ).toEqual(['https://crm.example.com', 'https://desktop.example.com']);
  });

  it.each([
    ['not-an-origin', 'a value that does not parse'],
    // `new URL('data:text/plain,x')` parses and its origin is the string "null" — the origin a
    // sandboxed iframe sends. On an allow-list it would match every sandboxed document.
    ['data:text/plain,x', 'a scheme with no origin'],
  ])('drops %s (%s) instead of trusting it', (extra) => {
    expect(allowedOrigins({ appUrl: 'https://crm.example.com', extraOrigins: extra })).toEqual([
      'https://crm.example.com',
    ]);
  });

  /**
   * `credentials: true` plus a reflected origin is the single most expensive CORS mistake: every
   * site the user visits can call this API with their session. The allow-list is a fixed list, and
   * `origin: true` never appears in the configuration (rules/security.mdc, rule 13).
   */
  it.each([
    'https://evil.example.com',
    'http://crm.example.com',
    'https://crm.example.com.evil.test',
    'null',
  ])('refuses %s', (origin) => {
    expect(isOriginAllowed(origin, ['https://crm.example.com'])).toBe(false);
  });

  it('accepts a configured origin', () => {
    expect(isOriginAllowed('https://crm.example.com', ['https://crm.example.com'])).toBe(true);
  });

  /**
   * A request with no `Origin` header is not a cross-origin request: `curl`, a health probe and a
   * server-to-server call all arrive this way, and CORS has nothing to say about them. The browser
   * — the only party CORS protects — always sends the header.
   */
  it('allows a request that carries no origin at all', () => {
    expect(isOriginAllowed(undefined, ['https://crm.example.com'])).toBe(true);
  });
});
