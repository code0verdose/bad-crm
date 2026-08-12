import { apiClient, idempotencyParams, unwrapApiResult, type components } from '@shared/api';

/**
 * The four calls of the second factor, one per operation, with no cache and no state above them
 * (`rules/frontend-fsd.mdc` rule 9).
 *
 * They live beside `auth.api.ts` rather than inside it because the file is a different subject —
 * signing in versus protecting the account one is already signed in to — and one file is one
 * responsibility (`rules/naming-and-structure.mdc` §7).
 *
 * **Everything here handles material that must not be stored.** The drafted secret and the ten
 * recovery codes exist in the response, on the screen, and nowhere else: no `localStorage`, no
 * query cache beyond the mutation that produced them, no URL, no log. That is why the two
 * operations that mint them are mutations rather than queries — a query is a cache entry by
 * definition, and the one thing these values must never become is a cache entry
 * (CLAUDE.md, «Чувствительность данных»). The server states the same intent on its side with
 * `Cache-Control: private, no-store`.
 */

/** What `POST /auth/2fa/setup` answers: the secret, its `otpauth://` URI and the QR as SVG. */
export type TotpEnrolmentDraft = components['schemas']['TotpSetupResult'];

/** Ten codes in the clear — the only time they exist outside a hash. */
export type RecoveryCodesIssued = components['schemas']['RecoveryCodesIssuedResult'];

/** `{ total, remaining }`, which is everything the API will ever say about a set that exists. */
export type RecoveryCodeStatus = components['schemas']['RecoveryCodesStatus'];

/**
 * The code **and** the current password.
 *
 * The password is not belt-and-braces: a session alone must not be able to attach a second factor,
 * or a stolen access token enrols the attacker's authenticator, carries off the recovery codes, and
 * leaves the owner unable to sign in once verification lands and unable to turn it off. The
 * password is checked whatever the code turns out to be, so a refusal tells a token holder nothing
 * about the code (`docs/api/openapi.yaml`, `confirmTotp`).
 */
export type TotpConfirmation = components['schemas']['ConfirmTotpRequest'];

/** The same two proofs the reissue has always demanded. */
export type RecoveryCodesReissue = components['schemas']['RegenerateRecoveryCodesRequest'];

/**
 * Drafts a secret. Repeated before confirmation, it replaces the draft rather than adding one — so
 * a person who lost the QR simply asks again, and the code from the discarded secret stops working.
 *
 * No signal: nothing later can overtake it, because the answer is the only copy of a value the
 * screen is about to show.
 */
export const setupTotp = async (): Promise<TotpEnrolmentDraft> =>
  unwrapApiResult(await apiClient.POST('/auth/2fa/setup', {}));

/**
 * Proves possession and turns 2FA on, answering with the ten recovery codes **once**.
 *
 * If this answer is lost in transit it is lost for good: 2FA is on, the database holds argon2id
 * hashes, and a retry answers `422 invalid_totp_code` because the draft is gone. The way out is
 * `regenerateRecoveryCodes` below, and the screen has to say so — the contract says so too, in the
 * operation's own description.
 */
export const confirmTotp = async (confirmation: TotpConfirmation): Promise<RecoveryCodesIssued> =>
  unwrapApiResult(
    await apiClient.POST('/auth/2fa/confirm', { ...idempotencyParams(), body: confirmation }),
  );

/** The signal is required, not optional: this is a query, and a query is always cancellable. */
export const fetchRecoveryCodeStatus = async (signal: AbortSignal): Promise<RecoveryCodeStatus> =>
  unwrapApiResult(await apiClient.GET('/auth/2fa/recovery-codes', { signal }));

/**
 * Replaces the whole set, in one transaction, behind the password and a live code.
 *
 * Also the escape hatch for the lost `confirm` answer: whoever has just enrolled holds both proofs
 * this asks for.
 */
export const regenerateRecoveryCodes = async (
  reissue: RecoveryCodesReissue,
): Promise<RecoveryCodesIssued> =>
  unwrapApiResult(
    await apiClient.POST('/auth/2fa/recovery-codes/regenerate', {
      ...idempotencyParams(),
      body: reissue,
    }),
  );
