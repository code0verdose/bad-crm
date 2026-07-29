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
   * Replaces the stored digest — the write half of the transparent re-hash.
   *
   * Called on a *successful* sign-in and only then, because that is the one moment the plaintext
   * exists and the person has already proved they know it. It deliberately touches neither
   * `permissionsVersion` nor any session: nothing about the account changed, only the cost of the
   * digest that stores its password (EPIC-006 acceptance).
   */
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
}
