import { type RequestHandler } from 'express';

import { MfaEnrollmentRequiredError } from '@/domain/shared/errors/app.errors.js';
import { readCaller } from '@/presentation/http/middleware/authenticate.middleware.js';

/**
 * Refuses a session whose only purpose is to enrol a second factor (STORY-013-05, acceptance 3).
 *
 * **Mounted from the declaration, not written into `handlers`** — the same mechanism the
 * authentication and permission guards use, and for the same reason: `route-registry.factory.ts`
 * prepends this to every authenticated route that does *not* carry `mfaEnrollmentAllowed`, so the
 * default for a route added tomorrow is «closed under the enrolment scope». A whitelist that had to
 * be remembered would be a whitelist that grows by omission.
 *
 * **It is the first of two refusals, not the only one.** The authoritative check that a scoped
 * session may do nothing lives in `BuildActorQuery` — the application-layer chokepoint every
 * capability-gated use-case passes through — which refuses with the same error even if this guard
 * were ever missing from a route. This one exists because it also covers the self-service routes,
 * which build no actor at all, and because it refuses before a body is parsed.
 */
export const createFullSessionMiddleware = (): RequestHandler => {
  return (_request, response, next) => {
    try {
      if (readCaller(response).mfaEnrollment) {
        next(new MfaEnrollmentRequiredError());

        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};
