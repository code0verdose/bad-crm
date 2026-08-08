import { apiClient, idempotencyParams, unwrapApiResult, type components } from '@shared/api';

/** What `POST /auth/login` accepts, straight from the contract. */
export type LoginCredentials = components['schemas']['LoginRequest'];

/** A session, or the choice that has to be made before one exists. Discriminated by `status`. */
export type LoginResult = components['schemas']['LoginResult'];

/** The address a reset link is asked for. Nothing else: an organization would have to be known. */
export type ForgotPasswordRequest = components['schemas']['ForgotPasswordRequest'];

/** The token from the mail and the password it buys — both in the body, by contract. */
export type ResetPasswordRequest = components['schemas']['ResetPasswordRequest'];

/**
 * Pure calls, one per operation — no cache, no state, no notification
 * (`rules/frontend-fsd.mdc` rule 9). Everything above them is `service/`.
 *
 * Both go through the one typed client, so they carry the access token, the idempotency key and the
 * 401-refresh-replay of `app/api-middleware.util.ts`. Sign-in is a public operation and needs none
 * of that on the way out; it goes through the same door anyway, because a second client is a second
 * place for a rule to be forgotten. The one call that genuinely must **not** take that door is the
 * refresh itself — a 401 is what starts a refresh — and it has its own instance in
 * `shared/api/session-refresh.api.ts`.
 *
 * `unwrapApiResult` is what turns a refused request into a rejection: `openapi-fetch` hands a 401
 * back as a value, while TanStack Query decides everything — the error state, the retry, the one
 * toast — on whether the function rejected.
 *
 * Neither takes an `AbortSignal`. `rules/tanstack-query.mdc` §4 asks for one in every `queryFn`,
 * because a query is re-issued when its key changes and the previous answer must not overwrite the
 * fresh one; a mutation has no key and is not re-issued, and a signal parameter nothing passes is a
 * branch nothing covers. It arrives with the first caller that has something to cancel.
 */
export const login = async (credentials: LoginCredentials): Promise<LoginResult> =>
  unwrapApiResult(await apiClient.POST('/auth/login', { body: credentials }));

/**
 * Ends the session this request belongs to. Answers 204 whether or not it was still alive, so there
 * is nothing to read back — what matters is that it was asked for, and that a refusal rejects.
 */
export const logout = async (): Promise<void> => {
  unwrapApiResult(await apiClient.POST('/auth/logout', {}));
};

/**
 * Asks for a reset link. Answers 202 with no body whether or not the address is registered, so there
 * is nothing to read back and nothing a caller could branch on — which is the point of the
 * operation, not an omission in it.
 */
export const requestPasswordReset = async (request: ForgotPasswordRequest): Promise<void> => {
  unwrapApiResult(
    await apiClient.POST('/auth/forgot-password', { ...idempotencyParams(), body: request }),
  );
};

/**
 * Spends a reset link.
 *
 * **The token goes in the body**, which is the contract rather than a preference: a query string is
 * written to the access log of every proxy in front of the installation, is handed to the next
 * origin in `Referer`, and is the part of a URL people paste into support tickets
 * (`docs/security/threat-model.md`, T-IAM-07). The emitted link carries it in a path segment of the
 * SPA route; this function is where it stops being part of a URL.
 *
 * Answers 204 and issues no session: whoever completes a reset signs in afterwards, because a
 * session minted straight from an emailed token is a session minted from something that sat in a
 * mailbox. Unknown, spent and expired are one refusal — `400 password_reset_token_invalid` — and
 * this client has no reason to want them apart either.
 */
export const confirmPasswordReset = async (request: ResetPasswordRequest): Promise<void> => {
  unwrapApiResult(
    await apiClient.POST('/auth/reset-password', { ...idempotencyParams(), body: request }),
  );
};

/** What the invited person supplies: no address and no name — see the schema's own note. */
export type InvitationAcceptance = components['schemas']['InvitationAcceptance'];

/** The same document sign-in answers with; acceptance ends in a session like every other entry. */
export type AcceptedInvitationSession = components['schemas']['AuthenticatedSession'];

/**
 * Takes up an invitation, creating the account and opening its first session.
 *
 * It lives beside sign-in rather than with the rest of the invitation surface because of what it
 * *is* from the client's side: the operation that ends with this tab holding a session. Everything
 * that follows — adopting the token, starting the store, announcing on the bus — is the code right
 * above, and a copy of it in another unit would be a second way to become signed in.
 */
export const acceptInvitation = async (
  acceptance: InvitationAcceptance,
): Promise<AcceptedInvitationSession> => {
  const { params } = idempotencyParams();

  return unwrapApiResult(await apiClient.POST('/invitations/accept', { body: acceptance, params }));
};
