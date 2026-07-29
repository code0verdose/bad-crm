import { type RequestHandler } from 'express';

import { UnauthenticatedError } from '@/domain/shared/errors/app.errors.js';
import { isOriginAllowed } from '@/presentation/http/cors-origin.util.js';

/**
 * The second lock on `POST /auth/refresh`: the request has to come from this installation.
 *
 * The refresh cookie is `SameSite=Lax`, which keeps it off cross-site *sub-resource* requests but
 * not off a top-level navigation — and a form auto-submitted from another page is a top-level POST.
 * `Lax` alone therefore does not fully cover the one endpoint the cookie authorises, so `Origin` is
 * checked as well (`docs/api/openapi.yaml`, `refreshCookie`; STORY-006-03).
 *
 * **A missing `Origin` is allowed, deliberately.** Browsers attach it to every POST, so its absence
 * means a non-browser client — `curl`, a native app, a health check — which carries no ambient
 * cookie to be exploited in the first place. Refusing it would break those callers to defend against
 * an attack they cannot mount. What is refused is an `Origin` that is *present and not ours*: that
 * is a browser saying, truthfully, that another site made this request.
 *
 * The refusal is the same `unauthenticated` code as every other way this endpoint says no.
 *
 * **It does not clear the cookie, deliberately.** Every refusal the *use-case* produces does — the
 * token is spent, unknown or replayed, and a client holding one this server will never accept again
 * should stop presenting it. This refusal is a different fact: the cookie was never examined, and it
 * is still perfectly good. Expiring it here would hand any page on the internet a working sign-out,
 * because the hidden form that gets this far carries the cookie by `SameSite=Lax` — a
 * cross-site-request-forgery logout built out of the middleware that exists to stop
 * cross-site-request forgery.
 *
 * The asymmetry is not an oracle for the attacker who caused it: their origin is not in the
 * allow-list, so the response carries no CORS headers and their script can read neither the body nor
 * `Set-Cookie`. What they observe is that nothing happened, which is also what they observe when the
 * token was spent.
 */
export const createSameOriginMiddleware = (allowedOrigins: readonly string[]): RequestHandler => {
  return (request, _response, next) => {
    const origin = request.headers.origin;

    if (typeof origin === 'string' && !isOriginAllowed(origin, allowedOrigins)) {
      next(new UnauthenticatedError());

      return;
    }

    next();
  };
};
