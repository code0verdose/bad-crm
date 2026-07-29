import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

/** The only two facts the decision needs; deliberately not the session row. */
export interface OwnedSession {
  readonly id: string;
  readonly userId: string;
  /** The device the row belongs to; revocation acts on the family, never on one row. */
  readonly familyId: string;
}

/**
 * Who may act on a session row: its owner, and nobody else.
 *
 * `DELETE /auth/sessions/{sessionId}` is a `SelfServiceRoute` — no capability gates it, so this
 * check *is* the authorization, and `route-registry.types.ts` requires the route to name the place
 * it happens. That place is here, called from the use-case rather than from a controller or a
 * repository, because invariant 2 of CLAUDE.md puts the authoritative decision in the use-case.
 *
 * **A stranger's session id and one that does not exist get the same answer, and it is 404.** The
 * ids are enumerable — the owner reads them from `GET /auth/sessions` and they change on every
 * rotation — so a 403 would confirm "this id is real and in use by somebody else", which is the
 * enumeration oracle the 404 rule exists to close (`docs/api/openapi.yaml`, `revokeSession`).
 *
 * The scope handed to `denyAccess` is `other_organization`, which is the value that produces a 404.
 * Its documented meaning is "belongs to another tenant, **or** we could not even establish that it
 * exists in this one" — and that second half is exactly the caller's position here: within their own
 * organization, a session they do not own is not theirs to establish the existence of.
 */
export const requireSessionOwner = (
  session: OwnedSession | null,
  callerUserId: string,
): OwnedSession => {
  if (session === null || session.userId !== callerUserId) {
    throw denyAccess('session', 'other_organization');
  }

  return session;
};
