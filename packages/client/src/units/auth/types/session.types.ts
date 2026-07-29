import { type SessionIdentity, type SessionStatus } from '@units/auth/model';

/**
 * Who the request is made as, once the session endpoint has answered.
 *
 * Re-exported rather than declared: the single definition is the schema that validates it
 * (`model/validation/session-identity.schema.ts`), so the type cannot drift from the check —
 * `rules/zod-validation.mdc` rule 1. This is the address a consumer expects it at.
 */
export type { SessionIdentity };

/**
 * A discriminated union rather than an optional identity: `session.userId` is then a compile error
 * in every branch where the client has no session, instead of `undefined` reaching a query key.
 */
export type SessionState =
  | { readonly status: Extract<SessionStatus, 'unknown' | 'anonymous'> }
  | ({ readonly status: Extract<SessionStatus, 'authenticated'> } & SessionIdentity);
