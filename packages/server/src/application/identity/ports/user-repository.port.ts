/**
 * Users of the organization in the current scope.
 *
 * Everything about *which* tenant comes from the scope opened by `UnitOfWorkPort`: no method takes
 * an `organizationId`, and a second answer to that question is one the policy silently overrules
 * (rules/tenancy-rls.mdc, 9).
 *
 * Reads that happen *before* a tenant is known — resolving an address at sign-in, resolving a
 * session from a cookie — are deliberately not here, and could not be: the policy would filter them
 * to nothing. They live behind `AuthLookupPort`, on the narrow `app_auth` surface of
 * `docs/security/rls-design.md` («Особые пути»).
 */

export interface OwnerDraft {
  readonly email: string;
  /** Already hashed by `PasswordHasherPort`; a plaintext password never crosses this boundary. */
  readonly passwordHash: string;
  /**
   * The person's interface language and timezone, which is everything `data-model.md` §1 puts on a
   * new `User` besides the address and the digest. There is no display name: the model has none, and
   * the registration contract deliberately does not invent one (`docs/api/openapi.yaml`).
   */
  readonly locale: string;
  readonly timezone: string;
}

/** The account as the session response and the authorization layer read it. */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly locale: string;
  readonly timezone: string;
  /** `ACTIVE` | `SUSPENDED` | `INVITED`, as the column spells it. */
  readonly status: string;
  readonly permissionsVersion: number;
}

/**
 * What a self-service password change needs about the caller, and the only place `passwordHash`
 * crosses this boundary.
 *
 * Deliberately not folded into `UserRecord`: that one is read on the session response and by the
 * authorization layer, and a digest that travels with it is a digest one careless serializer puts in
 * a body. This shape exists for exactly one caller — `ChangePasswordUseCase` — and leaves it only
 * into `PasswordHasherPort.verify`.
 *
 * `email` comes along because the attempt counter is keyed on the pair of address and account
 * (`rate-limit.port.ts`): reading it here is what lets a wrong current password land in the same
 * budget a wrong login does, instead of a second, uncounted way to guess a password.
 *
 * `locale` comes along because the notification is written in the person's own language, and EN and
 * RU are equal (`rules/i18n.mdc`).
 */
export interface UserCredentialRecord {
  readonly email: string;
  readonly passwordHash: string;
  readonly locale: string;
}

export interface UserRepositoryPort {
  /**
   * Creates the first, `ACTIVE` user of the organization in the current scope and returns its id.
   *
   * No `organizationId` argument: the row belongs to the tenant of the surrounding transaction, and
   * the policy would refuse any other value anyway (rules/tenancy-rls.mdc, 9).
   */
  createOwner(draft: OwnerDraft): Promise<string>;

  findById(userId: string): Promise<UserRecord | null>;

  /**
   * The digest and the address of one account of the current tenant, for the two operations that
   * are allowed to read them: verifying a current password, and addressing a notification.
   *
   * `null` when the row is gone or soft-deleted — which a live session can outlive, and which the
   * caller answers as a refused credential rather than as "no such account".
   */
  findCredential(userId: string): Promise<UserCredentialRecord | null>;

  /**
   * Replaces the stored digest. **Answers whether a row was actually written.**
   *
   * Three callers with three different stakes in that answer, which is why it is returned rather
   * than assumed:
   *
   * - the transparent re-hash on a successful sign-in may ignore it — the account moved or was
   *   soft-deleted between the lookup and the write, and leaving the digest as it was is the
   *   correct outcome (`user.repository.ts` on why the statement is an `updateMany`);
   * - `ChangePasswordUseCase` and `ConfirmPasswordResetUseCase` may **not**. For them a write that
   *   matched nothing is a password that did not change, and both of them go on to revoke sessions
   *   and answer success. A silent zero there is the failure mode of an operation reporting that it
   *   did something it did not do, and it is invisible in the response, in the log and in the
   *   metrics alike.
   *
   * `false` therefore means "no row matched `id = $1 AND deleted_at IS NULL`", not "the statement
   * failed" — a driver error still raises.
   */
  updatePasswordHash(userId: string, passwordHash: string): Promise<boolean>;
}
