import { type Request, type Response } from 'express';

import { API_PREFIX } from '@/presentation/http/api-version.constant.js';

/** The cookie name published by the `refreshCookie` security scheme of `docs/api/openapi.yaml`. */
export const REFRESH_COOKIE_NAME = 'bad_crm_refresh';

/**
 * The attributes are the contract, not a preference, and each one removes a different attack.
 *
 * - `httpOnly` — no script can read it, which is what makes an XSS worth fifteen minutes instead of
 *   thirty days;
 * - `secure` — never sent over plaintext HTTP. Kept on unconditionally: browsers treat `localhost`
 *   as a trustworthy origin, so development is unaffected, and a flag that is "off in dev" is a flag
 *   somebody ships off;
 * - `sameSite: 'lax'` — not sent on a cross-site POST. `strict` would make a link from a
 *   notification mail look like a signed-out visitor;
 * - `path` — the cookie is attached to `/api/v1/auth` and to nothing else, so a bug in any other
 *   endpoint cannot be reached by a request that carries this credential.
 */
const ATTRIBUTES = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: `${API_PREFIX}/auth`,
} as const;

/** Issues the refresh token, replacing whatever was there. */
export const setRefreshCookie = (response: Response, token: string, expiresAt: Date): void => {
  response.cookie(REFRESH_COOKIE_NAME, token, { ...ATTRIBUTES, expires: expiresAt });
};

/**
 * Expires the cookie with **the same attributes it was set with**.
 *
 * A clearing cookie on a different `Path` does not replace the original — the browser keeps both and
 * keeps sending the old one, which is how "sign out" turns into "still signed in after a reload".
 */
export const clearRefreshCookie = (response: Response): void => {
  response.clearCookie(REFRESH_COOKIE_NAME, ATTRIBUTES);
};

/** The presented token, or `undefined`. `cookie-parser` is mounted for the whole application. */
export const readRefreshCookie = (request: Request): string | undefined => {
  const cookies: unknown = (request as { cookies?: unknown }).cookies;

  if (typeof cookies !== 'object' || cookies === null) return undefined;

  const value = (cookies as Record<string, unknown>)[REFRESH_COOKIE_NAME];

  return typeof value === 'string' && value !== '' ? value : undefined;
};
