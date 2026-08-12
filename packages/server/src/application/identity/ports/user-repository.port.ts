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
 * What a self-service reauthentication needs about the caller, and the only place `passwordHash`
 * crosses this boundary.
 *
 * Deliberately not folded into `UserRecord`: that one is read on the session response and by the
 * authorization layer, and a digest that travels with it is a digest one careless serializer puts in
 * a body. This shape exists for every use-case that re-checks the current password against a live
 * session — `ChangePasswordUseCase`, `ConfirmTotpUseCase` and `RegenerateRecoveryCodesUseCase` — and
 * leaves it only into `PasswordHasherPort.verify`.
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
