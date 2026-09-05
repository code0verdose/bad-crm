import { apiClient, unwrapApiResult, type components } from '@shared/api';

/**
 * One live session as `/settings/security` renders it — a **family**, not a row: a rotation writes a
 * new `Session` carrying the same `familyId`, so one entry is one device.
 *
 * Nothing here identifies the credential. `refreshTokenHash`, `familyId` and `ipHash` stay on the
 * server, and `ipMasked` is the address with its host part already removed — masked at sign-in,
 * before the row was written, because the other address column is a hash and a hash cannot be masked
 * into something readable (`docs/architecture/data-model.md`, «Про адрес сессии»).
 */
export type SessionSummary = components['schemas']['SessionSummary'];

/** `{ revokedCount }` — how many were closed by *this* call, not how many are gone. */
export type RevokeOtherSessionsResult = components['schemas']['RevokeOtherSessionsResult'];

/**
 * The three session calls, one per operation, with no cache and no state above them
 * (`rules/frontend-fsd.mdc` rule 9).
 *
 * They live beside `auth.api.ts` rather than inside it because the subject is different — the
 * places this account is signed in, rather than the act of signing in — and one file is one
 * responsibility (`rules/naming-and-structure.mdc` §7).
 *
 * **Neither write takes an `Idempotency-Key`, and that is the contract.** Both are idempotent by
 * construction: revoking an already revoked session answers 204 again, and a second
 * `revoke-others` answers `revokedCount: 0`. The specification says the header is ignored on both,
 * so sending one would be a header the server drops.
 */

/**
 * Every session of the caller that is neither revoked nor expired.
 *
 * The `signal` is required rather than optional, for the reason `fetchRecoveryCodeStatus` states
 * about its own: this is a query, and a query is always cancellable — leaving the screen while it is
 * in flight must not leave a request to answer into a dead tree (`rules/tanstack-query.mdc` §4). An
 * optional parameter would be a parameter somebody omits.
 */
export const listSessions = async (signal: AbortSignal): Promise<readonly SessionSummary[]> =>
  unwrapApiResult(await apiClient.GET('/auth/sessions', { signal })).items;

/**
 * Closes one session — possibly the caller's own, which the contract permits and which behaves like
 * signing out, cookie clearing included.
 *
 * A session id that does not exist and one belonging to somebody else are the same `404
 * session_not_found`: 403 would confirm that the id is real and in use by another person, over a
 * resource whose ids are enumerable.
 */
export const revokeSession = async (sessionId: string): Promise<void> => {
  unwrapApiResult(
    await apiClient.DELETE('/auth/sessions/{sessionId}', { params: { path: { sessionId } } }),
  );
};

/** Closes every session except this one. The caller stays signed in. */
export const revokeOtherSessions = async (): Promise<RevokeOtherSessionsResult> =>
  unwrapApiResult(await apiClient.POST('/auth/sessions/revoke-others', {}));
