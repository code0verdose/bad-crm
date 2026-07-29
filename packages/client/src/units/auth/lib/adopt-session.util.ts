import { type RefreshedSession } from '@shared/api';
import { sessionIdentitySchema, type SessionIdentity } from '@units/auth/model';

import { clearAccessToken, setAccessToken } from './auth-token-storage.util.js';

/**
 * The one place an answer that contains a session is taken apart.
 *
 * Both doors into a session end here — `POST /auth/login` and `POST /auth/refresh` return the same
 * `AuthenticatedSession` — and both have to do the same two things with it: put the access token in
 * memory, and hand the caller an identity that does **not** contain it. One function rather than
 * two call sites, because the invariant it keeps is the kind that is broken by copying
 * (CLAUDE.md, invariant 3: nothing that authenticates a request leaves this module).
 *
 * The identity is parsed rather than trusted. `format: uuid` in the contract is a promise the
 * generated types cannot enforce, and these two values become branded ids that reach query keys and
 * tenant-scoped requests; an answer this client cannot read is not a session, and the previous
 * token goes with it — staying signed in on the strength of a body we could not parse is worse than
 * signing out.
 */
export const adoptSession = (session: RefreshedSession | null): SessionIdentity | null => {
  if (session === null) {
    clearAccessToken();

    return null;
  }

  const identity = sessionIdentitySchema.safeParse(session);

  if (!identity.success) {
    clearAccessToken();

    return null;
  }

  setAccessToken(session.accessToken);

  return identity.data;
};
