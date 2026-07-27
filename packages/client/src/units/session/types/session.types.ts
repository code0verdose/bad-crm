import { type OrganizationId, type UserId } from '@bad-crm/shared';

import { type SessionStatus } from '@units/session/model';

/** Who the request is made as, once the session endpoint has answered. */
export interface SessionIdentity {
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
}

/**
 * A discriminated union rather than an optional identity: `session.userId` is then a compile error
 * in every branch where the client has no session, instead of `undefined` reaching a query key.
 */
export type SessionState =
  | { readonly status: Extract<SessionStatus, 'unknown' | 'anonymous'> }
  | ({ readonly status: Extract<SessionStatus, 'authenticated'> } & SessionIdentity);
